import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Agent Hawke is live 🦅");
});

app.post("/run-intelligence", async (req, res) => {
  res.json({
    message: "Hawke intelligence run triggered",
    scanned: 0,
    anomalies_detected: 0
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Agent Hawke running on port ${PORT}`);
});
