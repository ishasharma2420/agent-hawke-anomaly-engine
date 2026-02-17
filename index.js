import express from "express";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const { LS_ACCESS_KEY, LS_SECRET_KEY, LS_BASE_URL } = process.env;

// ─── Auth params reused across all LS calls ───
const lsAuth = { accessKey: LS_ACCESS_KEY, secretKey: LS_SECRET_KEY };

// ─── Health check ───
app.get("/", (req, res) => {
  res.send("Agent Hawke is live 🦅");
});

// ═══════════════════════════════════════════════════════════════════
// APPROACH A — Query LEADS by ProspectStage (Lead-level stages)
// Endpoint: Search Leads by Criteria
// ═══════════════════════════════════════════════════════════════════
app.post("/run-intelligence", async (req, res) => {
  try {
    const stages = [
      "Engagement Initiated",
      "Application Pending",
      "Application Completed",
    ];

    let allLeads = [];

    for (const stage of stages) {
      const response = await axios.post(
        `${LS_BASE_URL}/v2/LeadManagement.svc/Leads.Get`,
        {
          Parameter: {
            LookupName: "ProspectStage",
            LookupValue: stage,
            SqlOperator: "=",
          },
          Columns: {
            Include_CSV:
              "ProspectID,FirstName,LastName,EmailAddress,ProspectStage,Phone,CreatedOn,ModifiedOn,Score,EngagementScore,Source",
          },
          Sorting: {
            ColumnName: "ModifiedOn",
            Direction: "1",
          },
          Paging: {
            PageIndex: 1,
            PageSize: 50,
          },
        },
        {
          params: lsAuth,
          headers: { "Content-Type": "application/json" },
        }
      );

      const leads = response.data?.Leads || [];
      console.log(`Stage "${stage}": found ${leads.length} leads`);
      allLeads.push(...leads);
    }

    console.log(`Total leads fetched: ${allLeads.length}`);

    const enriched = allLeads.map((lead) => {
      const props = {};
      if (lead.LeadPropertyList) {
        lead.LeadPropertyList.forEach((p) => {
          props[p.Attribute] = p.Value;
        });
      }
      return {
        prospectId: props.ProspectID || lead.ProspectID,
        name: `${props.FirstName || ""} ${props.LastName || ""}`.trim(),
        email: props.EmailAddress || null,
        stage: props.ProspectStage || null,
        score: parseInt(props.Score || "0", 10),
        engagementScore: parseInt(props.EngagementScore || "0", 10),
        source: props.Source || null,
        modifiedOn: props.ModifiedOn || null,
      };
    });

    res.json({
      message: "Hawke scanned pipeline stages",
      scanned: enriched.length,
      leads: enriched,
    });
  } catch (error) {
    console.error(
      "Error fetching leads:",
      error.response?.data || error.message
    );
    res.status(500).json({ error: "Failed to fetch leads" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// APPROACH B — Query ACTIVITIES on a custom object (e.g. OT_2)
// Endpoint: Activity Advanced Search
// ═══════════════════════════════════════════════════════════════════
app.post("/run-intelligence-custom-object", async (req, res) => {
  try {
    const STUDENT_OBJECT_EVENT_CODE = 12002; // ← CHANGE THIS to your OT_2 event code

    const response = await axios.post(
      `${LS_BASE_URL}/v2/ProspectActivity.svc/Activity/Retrieve/BySearchParameter`,
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
          PageSize: 50,
        },
        Sorting: {
          ColumnName: "CreatedOn",
          Direction: 1,
        },
      },
      {
        params: lsAuth,
        headers: { "Content-Type": "application/json" },
      }
    );

    const records = response.data?.List || [];
    console.log(`Custom object records fetched: ${records.length}`);

    const targetStages = [
      "Engagement Initiated",
      "Application Pending",
      "Application Completed",
    ];

    const filtered = records.filter((r) => {
      const stage = r.mx_Custom_2 || r.Status || "";
      return targetStages.includes(stage);
    });

    console.log(`Filtered to ${filtered.length} records in target stages`);

    res.json({
      message: "Hawke scanned custom object (Student) records",
      totalRecords: records.length,
      filteredByStage: filtered.length,
      records: filtered,
    });
  } catch (error) {
    console.error(
      "Error fetching custom object records:",
      error.response?.data || error.message
    );
    res.status(500).json({ error: "Failed to fetch custom object records" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// UTILITY — Get all Activity Types (to find your OT_2 event code)
// ═══════════════════════════════════════════════════════════════════
app.get("/activity-types", async (req, res) => {
  try {
    const response = await axios.get(
      `${LS_BASE_URL}/v2/ProspectActivity.svc/ActivityTypes.Get`,
      {
        params: lsAuth,
        headers: { "Content-Type": "application/json" },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error(
      "Error fetching activity types:",
      error.response?.data || error.message
    );
    res.status(500).json({ error: "Failed to fetch activity types" });
  }
});

// ═══════════════════════════════════════════════════════════════════
// WRITEBACK — Post an AI Decision Event activity back to a lead
// ═══════════════════════════════════════════════════════════════════
app.post("/write-decision", async (req, res) => {
  try {
    const { leadId, decision, riskLevel, findings } = req.body;

    if (!leadId || !decision) {
      return res.status(400).json({ error: "leadId and decision are required" });
    }

    const AI_DECISION_EVENT_CODE = 230; // ← CHANGE THIS

    const response = await axios.post(
      `${LS_BASE_URL}/v2/ProspectActivity.svc/Create`,
      {
        RelatedProspectId: leadId,
        ActivityEvent: AI_DECISION_EVENT_CODE,
        ActivityNote: `Agent Hawke Decision: ${decision}`,
        ActivityDateTime: new Date().toISOString().replace("T", " ").slice(0, 19),
        Fields: [
          { SchemaName: "mx_Custom_1", Value: decision },
          { SchemaName: "mx_Custom_2", Value: riskLevel || "Unknown" },
          { SchemaName: "mx_Custom_3", Value: findings || "" },
        ],
      },
      {
        params: lsAuth,
        headers: { "Content-Type": "application/json" },
      }
    );

    console.log(`Decision written for lead ${leadId}: ${decision}`);
    res.json({
      message: "Decision activity posted",
      activityId: response.data?.Message?.Id || response.data,
    });
  } catch (error) {
    console.error(
      "Error writing decision:",
      error.response?.data || error.message
    );
    res.status(500).json({ error: "Failed to write decision activity" });
  }
});

// ─── Start server ───
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Agent Hawke running on port ${PORT}`);
});
