import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const { LS_ACCESS_KEY, LS_SECRET_KEY } = process.env;

// Strip trailing slash from BASE_URL to prevent double-slash issues
const LS_BASE_URL = (process.env.LS_BASE_URL || "").replace(/\/+$/, "");

/* ================================
   CONFIG
================================ */

// ⚠️ IMPORTANT: Set this to your Student object's event code.
// Use GET /discover-activity-types to find it.
// Look for an entry with EventName containing "Student" or similar.
const STUDENT_OBJECT_EVENT_CODE = 12002; // ← CHANGE THIS

const TARGET_STAGES = [
  "Engagement Initiated",
  "Application Pending",
  "Application Completed",
];

const HIGH_INTENT_SOURCES = [
  "B2B Referral",
  "Website",
  "Chatbot",
  "Inbound Phone Call",
  "Pay per Click Ads",
];

const COUNSELOR_KEYWORDS = [
  "Inbound Phone Call Activity",
  "Outbound Phone Call Activity",
  "Invorto Call Qualification",
  "Meeting",
  "Flostack Appointment",
];

const ENGAGEMENT_KEYWORDS = [
  "Email Opened",
  "Email Link Clicked",
  "Dynamic Form Submission",
  "Inbound Phone Call Activity",
  "Outbound Phone Call Activity",
  "Logged into Portal",
  "Logged out of Portal",
  "Flostack Appointment",
  "Invorto Call Qualification",
  "Meeting",
];

/* ================================
   HELPERS
================================ */

function daysBetween(dateString) {
  if (!dateString) return 0;
  const today = new Date();
  const past = new Date(dateString);
  return Math.floor((today - past) / (1000 * 60 * 60 * 24));
}

/* ================================
   DISCOVER ACTIVITY TYPES
   GET /ProspectActivity.svc/ActivityTypes.Get
   
   Use this to find your Student object event code.
================================ */

app.get("/discover-activity-types", async (req, res) => {
  try {
    const response = await axios.get(
      `${LS_BASE_URL}/ProspectActivity.svc/ActivityTypes.Get`,
      {
        params: {
          accessKey: LS_ACCESS_KEY,
          secretKey: LS_SECRET_KEY,
        },
      }
    );

    // Filter to custom activity types (EventType = 2) for easier reading
    const allTypes = response.data || [];
    const customTypes = allTypes.filter((t) => t.EventType === 2);

    res.json({
      message: "Find your Student object event code below",
      instruction:
        "Look for the entry that matches your Student/OT_2 object. Copy its EventCode and set STUDENT_OBJECT_EVENT_CODE in index.js.",
      total_activity_types: allTypes.length,
      custom_activity_types: customTypes,
      all_activity_types: allTypes,
    });
  } catch (error) {
    console.error("Failed to fetch activity types:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch activity types" });
  }
});

/* ================================
   FETCH STUDENT RECORDS BY STAGE
   POST /ProspectActivity.svc/Activity/Retrieve/BySearchParameter
   (Activity Advanced Search)
================================ */

async function fetchStudentsByStage(stage) {
  const response = await axios.post(
    `${LS_BASE_URL}/ProspectActivity.svc/Activity/Retrieve/BySearchParameter`,
    {
      ActivityEventCode: STUDENT_OBJECT_EVENT_CODE,
      AdvancedSearch: JSON.stringify({
        GrpConOp: "And",
        Conditions: [
          {
            Type: "Activity",
            ConOp: "and",
            RowCondition: [
              {
                SubConOp: "And",
                LSO: "ActivityEvent",
                LSO_Type: "PAEvent",
                Operator: "eq",
                RSO: String(STUDENT_OBJECT_EVENT_CODE),
              },
              {
                SubConOp: "And",
                LSO: "Status",
                LSO_Type: "SearchableDropdown",
                Operator: "eq",
                RSO: stage,
              },
            ],
          },
        ],
        QueryTimeZone: "",
      }),
      Paging: {
        PageIndex: 1,
        PageSize: 100,
      },
      Sorting: {
        ColumnName: "CreatedOn",
        Direction: 1,
      },
    },
    {
      params: {
        accessKey: LS_ACCESS_KEY,
        secretKey: LS_SECRET_KEY,
      },
      headers: { "Content-Type": "application/json" },
    }
  );

  return response.data?.List || [];
}

/* ================================
   FETCH ALL STUDENT RECORDS (no stage filter)
   Fallback if stage filtering via AdvancedSearch doesn't work
   for your specific field schema.
================================ */

async function fetchAllStudents() {
  const response = await axios.post(
    `${LS_BASE_URL}/ProspectActivity.svc/Activity/Retrieve/BySearchParameter`,
    {
      ActivityEventCode: STUDENT_OBJECT_EVENT_CODE,
      AdvancedSearch: JSON.stringify({
        GrpConOp: "And",
        Conditions: [
          {
            Type: "Activity",
            ConOp: "and",
            RowCondition: [
              {
                SubConOp: "And",
                LSO: "ActivityEvent",
                LSO_Type: "PAEvent",
                Operator: "eq",
                RSO: String(STUDENT_OBJECT_EVENT_CODE),
              },
            ],
          },
        ],
        QueryTimeZone: "",
      }),
      Paging: {
        PageIndex: 1,
        PageSize: 200,
      },
      Sorting: {
        ColumnName: "CreatedOn",
        Direction: 1,
      },
    },
    {
      params: {
        accessKey: LS_ACCESS_KEY,
        secretKey: LS_SECRET_KEY,
      },
      headers: { "Content-Type": "application/json" },
    }
  );

  return response.data?.List || [];
}

/* ================================
   FETCH ACTIVITIES FOR A LEAD
   POST /ProspectActivity.svc/Retrieve?leadId=X
================================ */

async function fetchActivities(leadId) {
  try {
    const response = await axios.post(
      `${LS_BASE_URL}/ProspectActivity.svc/Retrieve`,
      {
        Parameter: {},
        Paging: {
          Offset: "0",
          RowCount: "50",
        },
      },
      {
        params: {
          accessKey: LS_ACCESS_KEY,
          secretKey: LS_SECRET_KEY,
          leadId: leadId,
        },
        headers: { "Content-Type": "application/json" },
      }
    );

    return response.data?.ProspectActivities || [];
  } catch (err) {
    console.error(`Failed to fetch activities for ${leadId}:`, err.response?.data || err.message);
    return [];
  }
}

/* ================================
   UPDATE LEAD FIELDS
   POST /LeadManagement.svc/Lead.Update?leadId=X
================================ */

async function updateLead(leadId, anomaly) {
  try {
    await axios.post(
      `${LS_BASE_URL}/LeadManagement.svc/Lead.Update`,
      [
        { Attribute: "mx_AI_Anomaly_Status", Value: "Active" },
        { Attribute: "mx_Latest_Anomaly_Type", Value: anomaly.type },
        { Attribute: "mx_Latest_Anomaly_Severity", Value: anomaly.severity },
        { Attribute: "mx_Latest_Anomaly_Confidence", Value: "90" },
        { Attribute: "mx_Latest_Anomaly_Explanation", Value: anomaly.explanation },
        {
          Attribute: "mx_Last_Intelligence_Run",
          Value: new Date().toISOString().replace("T", " ").slice(0, 19),
        },
      ],
      {
        params: {
          accessKey: LS_ACCESS_KEY,
          secretKey: LS_SECRET_KEY,
          leadId: leadId,
        },
        headers: { "Content-Type": "application/json" },
      }
    );
    console.log(`✅ Lead updated: ${leadId} → ${anomaly.type}`);
  } catch (err) {
    console.error(`❌ Failed to update lead ${leadId}:`, err.response?.data || err.message);
  }
}

/* ================================
   LOG AI DECISION AS ACTIVITY
   POST /ProspectActivity.svc/Create
================================ */

const AI_DECISION_EVENT_CODE = 230; // ← CHANGE THIS to your actual event code

async function logAIDecision(leadId, anomaly) {
  try {
    await axios.post(
      `${LS_BASE_URL}/ProspectActivity.svc/Create`,
      {
        RelatedProspectId: leadId,
        ActivityEvent: AI_DECISION_EVENT_CODE,
        ActivityNote: `Agent Hawke: ${anomaly.type} (${anomaly.severity})`,
        ActivityDateTime: new Date().toISOString().replace("T", " ").slice(0, 19),
        Fields: [
          { SchemaName: "mx_Custom_1", Value: anomaly.type },
          { SchemaName: "mx_Custom_2", Value: anomaly.severity },
          { SchemaName: "mx_Custom_3", Value: anomaly.explanation },
          { SchemaName: "mx_Custom_4", Value: "Agent Hawke" },
        ],
      },
      {
        params: {
          accessKey: LS_ACCESS_KEY,
          secretKey: LS_SECRET_KEY,
        },
        headers: { "Content-Type": "application/json" },
      }
    );
    console.log(`✅ Activity logged: ${leadId} → ${anomaly.type}`);
  } catch (err) {
    console.error(`❌ Failed to log activity for ${leadId}:`, err.response?.data || err.message);
  }
}

/* ================================
   HEALTH CHECK
================================ */

app.get("/", (req, res) => {
  res.send("Agent Hawke is live 🦅");
});

/* ================================
   RAW FETCH — Debug endpoint to see raw student records
   Helps identify field names for stage, source, etc.
================================ */

app.get("/debug-students", async (req, res) => {
  try {
    const records = await fetchAllStudents();
    res.json({
      message: `Found ${records.length} student records`,
      instruction:
        "Look at the field names to identify which mx_Custom_X holds Object Stage, Source, Stage Entered On, Offer Given Date",
      sample: records.slice(0, 3),
      total: records.length,
    });
  } catch (error) {
    console.error("Debug fetch failed:", error.response?.data || error.message);
    res.status(500).json({ error: "Debug fetch failed", details: error.response?.data || error.message });
  }
});

/* ================================
   MAIN ENGINE
================================ */

app.post("/run-intelligence", async (req, res) => {
  try {
    // --- Step 1: Fetch all student object records ---
    console.log("Fetching all student records...");
    const allRecords = await fetchAllStudents();
    console.log(`Total student records fetched: ${allRecords.length}`);

    if (allRecords.length === 0) {
      return res.json({
        message: "Hawke scanned — no student records found",
        total_records: 0,
        anomalies_detected: 0,
        debug: {
          event_code_used: STUDENT_OBJECT_EVENT_CODE,
          base_url: LS_BASE_URL,
          hint: "Use GET /discover-activity-types to verify your Student object event code",
        },
      });
    }

    // --- Step 2: Filter to target stages and run anomaly detection ---
    // Identify which field holds the Object Stage.
    // Common patterns: Status, mx_Custom_1, mx_Custom_2, etc.
    // Use GET /debug-students to check your actual field names.
    // Below we check multiple possible field names:

    let anomalyCount = 0;
    const anomalies = [];
    let stageFieldName = null;

    for (const record of allRecords) {
      // Try to detect the stage field — adjust based on /debug-students output
      const stage = (
        record.Status ||
        record.mx_Custom_1 ||
        record.mx_Custom_2 ||
        ""
      ).trim();

      // Track which field we found the stage in (for logging)
      if (!stageFieldName && TARGET_STAGES.includes(stage)) {
        if (record.Status === stage) stageFieldName = "Status";
        else if (record.mx_Custom_1 === stage) stageFieldName = "mx_Custom_1";
        else if (record.mx_Custom_2 === stage) stageFieldName = "mx_Custom_2";
      }

      if (!TARGET_STAGES.includes(stage)) continue;

      const leadId = record.RelatedProspectId;
      const name = `${record.mx_Custom_3 || record.mx_Custom_1 || ""} ${record.mx_Custom_4 || record.mx_Custom_2 || ""}`.trim() || leadId;
      const source = record.mx_Custom_5 || record.mx_Custom_6 || "";
      const stageEntered = record.mx_Custom_7 || record.mx_Custom_8 || record.CreatedOn || "";
      const offerDate = record.mx_Custom_9 || record.mx_Custom_10 || "";

      const daysInStage = daysBetween(stageEntered);
      const offerAge = daysBetween(offerDate);

      console.log(
        `Checking: ${name} | Stage: ${stage} | Source: ${source} | DaysInStage: ${daysInStage} | OfferAge: ${offerAge}`
      );

      let anomaly = null;

      /* 1️⃣ OFFER STALLED */
      if (offerDate && stage !== "Enrolled" && offerAge > 14) {
        anomaly = {
          type: "Offer Stalled",
          severity: "High",
          explanation: `Offer given ${offerAge} days ago but student not enrolled.`,
        };
      }

      /* 2️⃣ APPLICATION COMPLETED – NO COUNSELOR FOLLOW UP */
      if (!anomaly && stage === "Application Completed" && daysInStage > 5) {
        if (leadId) {
          const activities = await fetchActivities(leadId);
          const hasCounselor = activities.some((a) => {
            const eventName = a.EventName || "";
            return COUNSELOR_KEYWORDS.some((kw) => eventName.includes(kw));
          });

          if (!hasCounselor) {
            anomaly = {
              type: "Application Completed – No Counselor Follow-up",
              severity: "High",
              explanation: `No counselor activity ${daysInStage} days after application completion.`,
            };
          }
        }
      }

      /* 3️⃣ APPLICATION PENDING – STALLED */
      if (!anomaly && stage === "Application Pending" && daysInStage > 7) {
        if (leadId) {
          const activities = await fetchActivities(leadId);
          const hasEngagement = activities.some((a) => {
            const eventName = a.EventName || "";
            return ENGAGEMENT_KEYWORDS.some((kw) => eventName.includes(kw));
          });

          if (!hasEngagement) {
            anomaly = {
              type: "Application Pending – Stalled",
              severity: "Medium",
              explanation: `No engagement activity ${daysInStage} days in Application Pending.`,
            };
          }
        }
      }

      /* 4️⃣ HIGH INTENT – NO MOVEMENT */
      if (
        !anomaly &&
        stage === "Engagement Initiated" &&
        HIGH_INTENT_SOURCES.includes(source) &&
        daysInStage > 7
      ) {
        anomaly = {
          type: "High Intent – No Movement",
          severity: "Medium",
          explanation: `High intent source but no stage movement for ${daysInStage} days.`,
        };
      }

      if (anomaly && leadId) {
        console.log(`🚨 Anomaly: ${name} → ${anomaly.type}`);
        await updateLead(leadId, anomaly);
        await logAIDecision(leadId, anomaly);
        anomalyCount++;
        anomalies.push({
          leadId,
          name,
          stage,
          source,
          daysInStage,
          ...anomaly,
        });
      }
    }

    res.json({
      message: "Hawke scanned successfully",
      total_records: allRecords.length,
      stage_field_detected: stageFieldName || "unknown — use GET /debug-students to identify",
      anomalies_detected: anomalyCount,
      anomalies,
    });
  } catch (error) {
    console.error("Hawke scan failed:", error.response?.data || error.message);
    res.status(500).json({
      error: "Hawke scan failed",
      details: error.response?.data || error.message,
    });
  }
});

/* ================================
   START SERVER
================================ */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Agent Hawke running on port ${PORT}`);
  console.log(`LS_BASE_URL: ${LS_BASE_URL}`);
  console.log(`Student Object Event Code: ${STUDENT_OBJECT_EVENT_CODE}`);
});
