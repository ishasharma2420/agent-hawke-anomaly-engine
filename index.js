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

const LEAD_TYPE_STUDENT = "OT_2";

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

// AI Decision Event code (from your LS Admin)
const AI_DECISION_EVENT_CODE = 211;

/* ================================
   HELPERS
================================ */

function daysBetween(dateString) {
  if (!dateString) return 0;
  const today = new Date();
  const past = new Date(dateString);
  return Math.floor((today - past) / (1000 * 60 * 60 * 24));
}

// Normalize LeadPropertyList array into a flat { key: value } object
function flattenLead(lead) {
  const props = {};
  if (lead.LeadPropertyList) {
    lead.LeadPropertyList.forEach((p) => {
      props[p.Attribute] = p.Value;
    });
  }
  return { ...lead, ...props };
}

/* ================================
   FETCH STUDENT LEADS BY STAGE
   POST /LeadManagement.svc/Leads.Get
   
   Queries by ProspectStage, then filters
   client-side for LeadType = OT_2 (Students only).
================================ */

async function fetchStudentsByStage(stage) {
  const response = await axios.post(
    `${LS_BASE_URL}/LeadManagement.svc/Leads.Get`,
    {
      Parameter: {
        LookupName: "ProspectStage",
        LookupValue: stage,
        SqlOperator: "=",
      },
      Columns: {
        Include_CSV: [
          "ProspectID",
          "FirstName",
          "LastName",
          "EmailAddress",
          "ProspectStage",
          "LeadType",
          "Source",
          "Phone",
          "CreatedOn",
          "ModifiedOn",
          "Score",
          "EngagementScore",
          "mx_Stage_Entered_On",
          "mx_Offer_Given_Date",
        ].join(","),
      },
      Sorting: {
        ColumnName: "ModifiedOn",
        Direction: "1",
      },
      Paging: {
        PageIndex: 1,
        PageSize: 200,
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

  // API returns a plain array, not { Leads: [...] }
  const rawLeads = Array.isArray(response.data) ? response.data : (response.data?.Leads || []);
  const allFlattened = rawLeads.map(flattenLead);

  // Filter to Students only (LeadType = OT_2)
  const students = allFlattened.filter(
    (l) => l.LeadType === LEAD_TYPE_STUDENT
  );

  console.log(
    `Stage "${stage}": ${rawLeads.length} total leads, ${students.length} students (OT_2)`
  );

  return students;
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
    console.error(
      `Failed to fetch activities for ${leadId}:`,
      err.response?.data || err.message
    );
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
        {
          Attribute: "mx_Latest_Anomaly_Explanation",
          Value: anomaly.explanation,
        },
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
    console.error(
      `❌ Failed to update lead ${leadId}:`,
      err.response?.data || err.message
    );
  }
}

/* ================================
   LOG AI DECISION AS ACTIVITY
   POST /ProspectActivity.svc/Create
================================ */

async function logAIDecision(leadId, anomaly) {
  try {
    await axios.post(
      `${LS_BASE_URL}/ProspectActivity.svc/Create`,
      {
        RelatedProspectId: leadId,
        ActivityEvent: AI_DECISION_EVENT_CODE,
        ActivityNote: `Agent Hawke: ${anomaly.type} (${anomaly.severity})`,
        ActivityDateTime: new Date()
          .toISOString()
          .replace("T", " ")
          .slice(0, 19),
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
    console.error(
      `❌ Failed to log activity for ${leadId}:`,
      err.response?.data || err.message
    );
  }
}

/* ================================
   HEALTH CHECK
================================ */

app.get("/", (req, res) => {
  res.send("Agent Hawke is live 🦅");
});

/* ================================
   MAIN ENGINE
================================ */

app.post("/run-intelligence", async (req, res) => {
  try {
    // --- Step 1: Fetch student leads across target stages ---
    let allStudents = [];

    for (const stage of TARGET_STAGES) {
      const students = await fetchStudentsByStage(stage);
      allStudents.push(...students);
    }

    console.log(`Total student leads fetched: ${allStudents.length}`);

    if (allStudents.length === 0) {
      return res.json({
        message: "Hawke scanned — no student leads found in target stages",
        total_leads_scanned: 0,
        anomalies_detected: 0,
        debug: {
          stages_queried: TARGET_STAGES,
          lead_type_filter: LEAD_TYPE_STUDENT,
          base_url_used: LS_BASE_URL,
        },
      });
    }

    // --- Step 2: Run anomaly detection rules ---
    let anomalyCount = 0;
    const anomalies = [];

    for (const lead of allStudents) {
      const stage = (lead.ProspectStage || "").trim();
      const source = (lead.Source || "").trim();
      const stageEntered = lead.mx_Stage_Entered_On;
      const offerDate = lead.mx_Offer_Given_Date;
      const leadId = lead.ProspectID;
      const name = `${lead.FirstName || ""} ${lead.LastName || ""}`.trim();

      const daysInStage = daysBetween(stageEntered);
      const offerAge = daysBetween(offerDate);

      console.log(
        `Checking: ${name} (${leadId}) | Stage: ${stage} | Source: ${source} | DaysInStage: ${daysInStage} | OfferAge: ${offerAge}`
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

      /* 3️⃣ APPLICATION PENDING – STALLED */
      if (!anomaly && stage === "Application Pending" && daysInStage > 7) {
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

      if (anomaly) {
        console.log(`🚨 Anomaly: ${name} → ${anomaly.type}`);
        await updateLead(leadId, anomaly);
        await logAIDecision(leadId, anomaly);
        anomalyCount++;
        anomalies.push({
          leadId,
          name,
          email: lead.EmailAddress || null,
          stage,
          source,
          daysInStage,
          ...anomaly,
        });
      }
    }

    res.json({
      message: "Hawke scanned successfully",
      total_leads_scanned: allStudents.length,
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
  console.log(`Filtering for LeadType: ${LEAD_TYPE_STUDENT}`);
});
