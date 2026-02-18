import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const {
  LS_ACCESS_KEY,
  LS_SECRET_KEY,
  LS_BASE_URL
} = process.env;

const HIGH_INTENT_SOURCES = [
  "B2B Referral",
  "Website",
  "Chatbot",
  "Inbound Phone Call",
  "Pay per Click Ads"
];

const COUNSELOR_KEYWORDS = [
  "Inbound Phone Call Activity",
  "Outbound Phone Call Activity",
  "Invorto Call Qualification",
  "Meeting",
  "Flostack Appointment"
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
  "Meeting"
];

function daysBetween(dateString) {
  if (!dateString) return 0;
  const today = new Date();
  const past = new Date(dateString);
  return Math.floor((today - past) / (1000 * 60 * 60 * 24));
}

async function updateLead(leadId, anomaly) {
  await axios.post(
    `${LS_BASE_URL}/LeadManagement.svc/Lead.Update`,
    [
      { Attribute: "mx_AI_Anomaly_Status", Value: "Active" },
      { Attribute: "mx_Latest_Anomaly_Type", Value: anomaly.type },
      { Attribute: "mx_Latest_Anomaly_Severity", Value: anomaly.severity },
      { Attribute: "mx_Latest_Anomaly_Confidence", Value: "90" },
      { Attribute: "mx_Latest_Anomaly_Explanation", Value: anomaly.explanation },
      { Attribute: "mx_Last_Intelligence_Run", Value: new Date().toISOString().split("T")[0] }
    ],
    {
      params: {
        accessKey: LS_ACCESS_KEY,
        secretKey: LS_SECRET_KEY,
        leadId: leadId
      },
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}

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
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}

async function fetchActivities(leadId) {
  const response = await axios.post(
    `${LS_BASE_URL}/LeadManagement.svc/Activities.Get`,
    {
      ProspectID: leadId,
      Paging: { PageIndex: 1, PageSize: 50 }
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

app.post("/run-intelligence", async (req, res) => {
  try {

    const response = await axios.post(
      `${LS_BASE_URL}/LeadManagement.svc/Leads.Get`,
      {
        Paging: { PageIndex: 1, PageSize: 200 }
      },
      {
        params: {
          accessKey: LS_ACCESS_KEY,
          secretKey: LS_SECRET_KEY
        }
      }
    );

    const leads = response.data || [];
    let anomalyCount = 0;

    for (const lead of leads) {

      const stage = (lead.ProspectStage || "").toLowerCase().trim();
      const stageEntered = lead.mx_Stage_Entered_On;
      const offerDate = lead.mx_Offer_Given_Date;
      const source = lead.Source;
      const leadId = lead.ProspectID;

      const daysInStage = daysBetween(stageEntered);
      const offerAge = daysBetween(offerDate);

      let anomaly = null;

      // 1️⃣ Offer Stalled
      if (offerDate && stage !== "enrolled" && offerAge > 14) {
        anomaly = {
          type: "Offer Stalled",
          severity: "High",
          explanation: `Offer given ${offerAge} days ago but student not enrolled.`
        };
      }

      // 2️⃣ Application Completed – No Counselor Follow-up
      if (!anomaly && stage === "application completed" && daysInStage > 5) {

        const activities = await fetchActivities(leadId);

        const recentCounselorActivity = activities.some(a => {
          const daysOld = daysBetween(a.ActivityDate);
          return (
            COUNSELOR_KEYWORDS.includes(a.ActivityEvent) &&
            daysOld <= 5
          );
        });

        if (!recentCounselorActivity) {
          anomaly = {
            type: "Application Completed – No Counselor Follow-up",
            severity: "High",
            explanation: `No counselor activity within 5 days of application completion.`
          };
        }
      }

      // 3️⃣ Application Pending – Stalled
      if (!anomaly && stage === "application pending" && daysInStage > 7) {

        const activities = await fetchActivities(leadId);

        const recentEngagement = activities.some(a => {
          const daysOld = daysBetween(a.ActivityDate);
          return (
            ENGAGEMENT_KEYWORDS.includes(a.ActivityEvent) &&
            daysOld <= 7
          );
        });

        if (!recentEngagement) {
          anomaly = {
            type: "Application Pending – Stalled",
            severity: "Medium",
            explanation: `No engagement activity within 7 days in Application Pending.`
          };
        }
      }

      // 4️⃣ High Intent – No Movement
      if (!anomaly &&
          stage === "engagement initiated" &&
          HIGH_INTENT_SOURCES.includes(source) &&
          daysInStage > 7) {

        anomaly = {
          type: "High Intent – No Movement",
          severity: "Medium",
          explanation: `High intent source but no stage movement for ${daysInStage} days.`
        };
      }

      if (anomaly) {
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
    console.error("URL FAILED:", error.config?.url);
console.error("ERROR:", error.response?.data || error.message);

    res.status(500).json({ error: "Hawke scan failed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Agent Hawke running on port ${PORT}`);
});
