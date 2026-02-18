import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const { LS_ACCESS_KEY, LS_SECRET_KEY, LS_BASE_URL } = process.env;

/* ================================
   CONFIG
================================ */

const HIGH_INTENT_SOURCES = [
  "b2b referral",
  "website",
  "chatbot",
  "inbound phone call",
  "pay per click ads"
];

const COUNSELOR_KEYWORDS = [
  "inbound phone call activity",
  "outbound phone call activity",
  "invorto call qualification",
  "meeting",
  "flostack appointment"
];

const ENGAGEMENT_KEYWORDS = [
  "email opened",
  "email link clicked",
  "dynamic form submission",
  "inbound phone call activity",
  "outbound phone call activity",
  "logged into portal",
  "logged out of portal",
  "flostack appointment",
  "invorto call qualification",
  "meeting"
];

/* ================================
   HELPERS
================================ */

function normalize(value) {
  return value ? value.toString().toLowerCase().trim() : "";
}

function daysBetween(dateString) {
  if (!dateString) return 0;

  const today = new Date();
  const past = new Date(dateString);

  if (isNaN(past.getTime())) return 0;

  const diff = today - past;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/* ================================
   UPDATE LEAD
================================ */

async function updateLead(leadId, anomaly) {
  await axios.post(
    `${LS_BASE_URL}/LeadManagement.svc/Lead.Update`,
    [
      { Attribute: "mx_AI_Anomaly_Status", Value: "Active" },
      { Attribute: "mx_Latest_Anomaly_Type", Value: anomaly.type },
      { Attribute: "mx_Latest_Anomaly_Severity", Value: anomaly.severity },
      { Attribute: "mx_Latest_Anomaly_Confidence", Value: 90 }, // number field
      { Attribute: "mx_Latest_Anomaly_Explanation", Value: anomaly.explanation },
      { Attribute: "mx_Last_Intelligence_Run", Value: new Date().toISOString().split("T")[0] }
    ],
    {
      params: {
        accessKey: LS_ACCESS_KEY,
        secretKey: LS_SECRET_KEY,
        leadId: leadId
      },
      headers: { "Content-Type": "application/json" }
    }
  );
}

/* ================================
   LOG ACTIVITY
================================ */

async function logAIDecision(leadId, anomaly) {
  await axios.post(
    `${LS_BASE_URL}/LeadManagement.svc/Activity.Create`,
    {
      RelatedProspectId: leadId,
      ActivityEvent: "AI Decision Event",
      ActivityFields: [
        { SchemaName: "mx_AI_Anomaly_Type", Value: anomaly.type },
        { SchemaName: "mx_AI_Anomaly_Severity", Value: anomaly.severity },
        { SchemaName: "mx_AI_Anomaly_Explanation", Value: anomaly.explanation },
        { SchemaName: "mx_AI_Agent_Name", Value: "Agent Hawke" }
      ]
    },
    {
      params: {
        accessKey: LS_ACCESS_KEY,
        secretKey: LS_SECRET_KEY
      },
      headers: { "Content-Type": "application/json" }
    }
  );
}

/* ================================
   FETCH ACTIVITIES
================================ */

async function fetchActivities(leadId) {
  const response = await axios.post(
    `${LS_BASE_URL}/LeadManagement.svc/Activity.Get`,
    {
      RelatedProspectId: leadId,
      Paging: { PageIndex: 1, PageSize: 20 }
    },
    {
      params: {
        accessKey: LS_ACCESS_KEY,
        secretKey: LS_SECRET_KEY
      }
    }
  );

  return response.data?.Data || [];
}

/* ================================
   MAIN ENGINE
================================ */

app.post("/run-intelligence", async (req, res) => {
  try {

    const response = await axios.post(
      `${LS_BASE_URL}/LeadManagement.svc/Leads.Get`,
      { Paging: { PageIndex: 1, PageSize: 100 } },
      {
        params: {
          accessKey: LS_ACCESS_KEY,
          secretKey: LS_SECRET_KEY
        }
      }
    );

    const leads = response.data?.Data || [];
    console.log("Total Leads Fetched:", leads.length);

    let anomalyCount = 0;

    for (const lead of leads) {

      const stage = normalize(lead.ProspectStage);
      const source = normalize(lead.Source);
      const stageEntered = lead.mx_Stage_Entered_On;
      const offerDate = lead.mx_Offer_Given_Date;
      const leadId = lead.ProspectID;

      const daysInStage = daysBetween(stageEntered);
      const offerAge = daysBetween(offerDate);

      let anomaly = null;

      /* ========= RULE 1: Offer Stalled ========= */
      if (
        offerDate &&
        stage !== "enrolled" &&
        offerAge > 14
      ) {
        anomaly = {
          type: "Offer Stalled",
          severity: "High",
          explanation: `Offer given ${offerAge} days ago but not enrolled.`
        };
      }

      /* ========= RULE 2: Application Completed – No Counselor Activity ========= */
      if (
        !anomaly &&
        stage === "application completed" &&
        daysInStage > 5
      ) {
        const activities = await fetchActivities(leadId);

        const counselorActivity = activities.some(a =>
          COUNSELOR_KEYWORDS.includes(normalize(a.ActivityEvent))
        );

        if (!counselorActivity) {
          anomaly = {
            type: "Application Completed – No Counselor Follow-up",
            severity: "High",
            explanation: `No counselor activity ${daysInStage} days after completion.`
          };
        }
      }

      /* ========= RULE 3: Application Pending – Stalled ========= */
      if (
        !anomaly &&
        stage === "application pending" &&
        daysInStage > 7
      ) {
        const activities = await fetchActivities(leadId);

        const engaged = activities.some(a =>
          ENGAGEMENT_KEYWORDS.includes(normalize(a.ActivityEvent))
        );

        if (!engaged) {
          anomaly = {
            type: "Application Pending – Stalled",
            severity: "Medium",
            explanation: `No engagement activity ${daysInStage} days in pending stage.`
          };
        }
      }

      /* ========= RULE 4: High Intent – No Movement ========= */
      if (
        !anomaly &&
        stage === "engagement initiated" &&
        HIGH_INTENT_SOURCES.includes(source) &&
        daysInStage > 7
      ) {
        anomaly = {
          type: "High Intent – No Movement",
          severity: "Medium",
          explanation: `High intent source but no stage movement for ${daysInStage} days.`
        };
      }

      if (anomaly) {
        console.log("ANOMALY DETECTED:", anomaly.type, "Lead:", leadId);
        await updateLead(leadId, anomaly);
        await logAIDecision(leadId, anomaly);
        anomalyCount++;
      }
    }

    res.json({
      message: "Hawke scanned successfully",
      anomalies_detected: anomalyCount
    });

  } catch (error) {
    console.error("ENGINE ERROR:", error.response?.data || error.message);
    res.status(500).json({ error: "Hawke scan failed" });
  }
});

/* ================================
   SERVER
================================ */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Agent Hawke running on port ${PORT}`);
});
