/**
 * Compares raw azure-diagnostics responses captured with and without skill use.
 *
 * Reads matching JSONL rows from both raw capture files, confirms they contain
 * the same prompt, and asks a tool-free Copilot judge to score both responses
 * with the same rubric.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  useAgentRunner,
  shouldSkipIntegrationTests,
  getIntegrationSkipReason,
  type AgentMetadata
} from "../utils/agent-runner";
import { getToolCalls, withTestResult } from "../utils/evaluate";

const TEST_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_ROW_LIMIT = 2;
const DEFAULT_SCORE_SAMPLE_COUNT = 5;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WITHOUT_SKILL_FILE = path.join(__dirname, "..", "reports", "azure-diagnostics-raw-call-data.jsonl");
const WITH_SKILL_FILE = path.join(__dirname, "azure-diagnostics-raw-call-data-with-skill.jsonl");
const SCENARIO_DIR = path.join(__dirname, "aks-troubleshoot-scenarios");
const REPORT_PATH = path.join("reports", "azure-diagnostics-raw-response-evaluation.jsonl");

interface RawCaptureRecord {
  promptIndex: number;
  promptCount: number;
  prompt: string;
  diagnosticsInvoked?: boolean;
  invokedSkillNames?: string[];
  finalAssistantMessage: string;
  allAssistantMessages?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  rawEvents?: Array<{
    type?: string;
    data?: unknown;
  }>;
}

interface JudgeScores {
  groundednessScore: number;
  rootCauseAnalysisScore: number;
}

const skipTests = shouldSkipIntegrationTests();
const skipReason = getIntegrationSkipReason();

if (skipTests && skipReason) {
  console.log(`Skipping integration tests: ${skipReason}`);
}

const describeIntegration = skipTests ? describe.skip : describe;

function readJsonlRecords(filePath: string): RawCaptureRecord[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as RawCaptureRecord);
}

function getRowLimit(): number {
  const parsed = Number.parseInt(process.env.RAW_RESPONSE_EVAL_LIMIT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROW_LIMIT;
}

function getScoreSampleCount(): number {
  const parsed = Number.parseInt(process.env.RAW_RESPONSE_EVAL_SAMPLE_COUNT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SCORE_SAMPLE_COUNT;
}

function getTokenCount(record: RawCaptureRecord): number {
  return (record.tokenUsage?.inputTokens ?? 0) + (record.tokenUsage?.outputTokens ?? 0);
}

function getAverage(values: number[]): number {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Number(average.toFixed(2));
}

function getFinalAssistantMessage(agentMetadata: AgentMetadata): string {
  const messages = new Map<string, string>();
  let lastMessageId: string | undefined;

  for (const event of agentMetadata.events) {
    if (event.type === "assistant.message" && event.data.messageId) {
      lastMessageId = event.data.messageId;
      if (event.data.content) {
        messages.set(event.data.messageId, event.data.content);
      }
    }

    if (event.type === "assistant.message_delta" && event.data.messageId) {
      lastMessageId = event.data.messageId;
      messages.set(
        event.data.messageId,
        `${messages.get(event.data.messageId) ?? ""}${event.data.deltaContent ?? ""}`
      );
    }
  }

  return lastMessageId ? messages.get(lastMessageId) ?? "" : "";
}

function appendJsonl(reportPath: string, record: unknown): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.appendFileSync(reportPath, `${JSON.stringify(record)}\n`, "utf-8");
}

function extractScenarioNames(prompt: string): string[] {
  return Array.from(new Set(prompt.match(/\bc[123]-[a-z0-9-]+\b/g) ?? []));
}

function getClusterNumberForPromptIndex(promptIndex: number): number {
  return Math.floor((promptIndex - 1) / 7) + 1;
}

function getScenarioContext(prompt: string, promptIndex: number): string {
  const scenarioNames = extractScenarioNames(prompt);
  const clusterNumber = getClusterNumberForPromptIndex(promptIndex);
  const clusterScenarioFile = path.join(SCENARIO_DIR, `alexok-aks-diagnostics-${clusterNumber}.yaml`);
  const clusterScenarioYaml = fs.readFileSync(clusterScenarioFile, "utf-8");
  const scenarioFiles = [clusterScenarioFile];

  const matchingDocuments: string[] = [];
  for (const scenarioFile of scenarioFiles) {
    const content = fs.readFileSync(scenarioFile, "utf-8");
    const header = content.split("---", 1)[0].trim();
    const documents = content
      .split(/\n---\n/g)
      .map(document => document.trim())
      .filter(document => document.length > 0);

    for (const document of documents) {
      if (scenarioNames.some(name => document.includes(name))) {
        matchingDocuments.push([header, document].filter(Boolean).join("\n"));
      }
    }
  }

  return [
    `Prompt index ${promptIndex} belongs to alexok-aks-diagnostics-${clusterNumber}.`,
    "The full YAML below is the authoritative ground truth for this cluster's configured diagnostic scenarios.",
    clusterScenarioYaml,
    matchingDocuments.length > 0
      ? [
        "The following YAML document(s) matched workload names in the prompt and are the most relevant scenario snippets.",
        matchingDocuments.join("\n\n---\n\n")
      ].join("\n")
      : "No workload-specific snippet was found; grade against the full cluster YAML above."
  ].join("\n\n");
}

function getConversationEvents(record: RawCaptureRecord): unknown[] {
  const conversationEventTypes = new Set([
    "user.message",
    "assistant.message",
    "assistant.message_delta",
    "tool.execution_start",
    "tool.execution_complete",
    "tool.execution_error",
    "skill.invoked"
  ]);

  return (record.rawEvents ?? [])
    .map((event, index) => ({ index, ...event }))
    .filter(event => event.type && conversationEventTypes.has(event.type));
}

function getFullRunConversation(record: RawCaptureRecord): string {
  return [
    `Prompt index: ${record.promptIndex} of ${record.promptCount}`,
    `Diagnostics skill invoked: ${record.diagnosticsInvoked ?? "unknown"}`,
    `Invoked skill names: ${(record.invokedSkillNames ?? []).join(", ") || "none recorded"}`,
    `Token usage: ${JSON.stringify(record.tokenUsage ?? {})}`,
    "Final assistant message:",
    record.finalAssistantMessage,
    "All assistant messages:",
    record.allAssistantMessages ?? "",
    "Full captured conversation and tool evidence events:",
    JSON.stringify(getConversationEvents(record), null, 2)
  ].join("\n\n");
}

function buildJudgePrompt(
  prompt: string,
  scenarioContext: string,
  runLabel: string,
  fullRunConversation: string
): string {
  return `Evaluate one AKS troubleshooting run against the prompt and strict rubric.

You must not call tools. You must not invoke skills. Use only the prompt, known AKS scenario setup, and captured run conversation below.

Authoritative ground truth:
- The raw output rows are grouped by cluster: rows 1-7 are alexok-aks-diagnostics-1, rows 8-14 are alexok-aks-diagnostics-2, and rows 15-21 are alexok-aks-diagnostics-3.
- The YAML from tests/azure-diagnostics/aks-troubleshoot-scenarios for that cluster is the source of truth for configured workloads, labels, selectors, probes, images, ports, ConfigMaps, Secrets, PVCs, NetworkPolicies, PDBs, HPAs, service accounts, and other scenario facts.
- A run may cite runtime evidence from the cluster, including tool outputs in the captured conversation, but configuration claims must be consistent with the YAML. Penalize claims that contradict the YAML or invent resources, ports, keys, labels, images, probes, or relationships that are not supported by the prompt, YAML, or captured evidence.

Groundedness score, 1-10:
- 10: All important factual claims are accurate against the authoritative YAML and prompt, and any extra runtime claims are clearly tied to captured or quoted evidence. No hallucinated details.
- 8-9: Mostly accurate and evidence-based, with only small omissions or minor unsupported details that do not affect the diagnosis.
- 6-7: Generally points at the right area but includes some unsupported or imprecise facts, weak evidence handling, or small contradictions.
- 4-5: Mixed accuracy. Some correct observations, but meaningful hallucinations, missing evidence, or unsupported assertions make the response only partly trustworthy.
- 2-3: Mostly ungrounded or contradicted by the YAML/prompt, even if it mentions a plausible Kubernetes concept.
- 1: Fundamentally false, unrelated, or almost entirely hallucinated.

Root cause analysis score, 1-10:
- 10: Identifies the true underlying issue or issues in the scenario, explains the causal chain from configured problem to symptom, distinguishes symptoms from causes, and gives an appropriate fix.
- 8-9: Finds the real root cause and gives useful remediation, but misses some nuance, supporting evidence, or secondary implications.
- 6-7: Finds the broad problem area but diagnosis is incomplete, shallow, or partly symptom-level.
- 4-5: Partially solves the prompt but misses an important underlying issue, confuses cause and symptom, or gives a weak/incomplete remediation.
- 2-3: Barely addresses the true issue; mostly generic troubleshooting or wrong cause with a small relevant fragment.
- 1: Does not find the problem at all.

Grade hard, strict, and fair. Apply exactly the same criteria to every run. Do not reward verbosity unless it improves correctness or root-cause depth.

Return only this JSON shape with integer scores from 1 through 10 and no markdown:
{
  "groundednessScore": 0,
  "rootCauseAnalysisScore": 0
}

Prompt:
${prompt}

Known AKS scenario setup:
${scenarioContext}

Run label:
${runLabel}

Captured run conversation:
${fullRunConversation}`;
}

function parseJudgeScores(rawMessage: string): JudgeScores {
  const trimmed = rawMessage.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonText = fencedMatch?.[1] ?? trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  const parsed = JSON.parse(jsonText) as JudgeScores;

  for (const [key, value] of Object.entries(parsed)) {
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      throw new Error(`Judge returned invalid ${key}: ${value}`);
    }
  }

  return parsed;
}

async function scoreRun(
  agent: ReturnType<typeof useAgentRunner>,
  prompt: string,
  scenarioContext: string,
  runLabel: string,
  record: RawCaptureRecord,
  sampleCount: number
): Promise<JudgeScores> {
  const groundednessScores: number[] = [];
  const rootCauseAnalysisScores: number[] = [];

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const judgeMetadata = await agent.run({
      prompt: buildJudgePrompt(
        prompt,
        scenarioContext,
        runLabel,
        getFullRunConversation(record)
      ),
      nonInteractive: true,
      includeSkills: [],
      systemPrompt: {
        mode: "replace",
        content: "You are a strict evaluator. Do not call tools. Do not invoke skills. Return only valid JSON matching the requested schema."
      }
    });

    const toolCalls = getToolCalls(judgeMetadata);
    expect(toolCalls).toHaveLength(0);

    const scores = parseJudgeScores(getFinalAssistantMessage(judgeMetadata));
    groundednessScores.push(scores.groundednessScore);
    rootCauseAnalysisScores.push(scores.rootCauseAnalysisScore);

    console.warn(`${runLabel} judge sample ${sampleIndex + 1}/${sampleCount}: groundedness=${scores.groundednessScore}, rootCause=${scores.rootCauseAnalysisScore}`);
  }

  return {
    groundednessScore: getAverage(groundednessScores),
    rootCauseAnalysisScore: getAverage(rootCauseAnalysisScores)
  };
}

describeIntegration("azure-diagnostics_ - Raw Response Evaluation", () => {
  const agent = useAgentRunner();

  test("evaluates matching raw responses with and without skill", async () => {
    await withTestResult(async () => {
      const withoutSkillRecords = readJsonlRecords(WITHOUT_SKILL_FILE);
      const withSkillRecords = readJsonlRecords(WITH_SKILL_FILE);
      const rowLimit = Math.min(getRowLimit(), withoutSkillRecords.length, withSkillRecords.length);
      const sampleCount = getScoreSampleCount();

      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, "", "utf-8");

      for (let index = 0; index < rowLimit; index++) {
        const withoutSkill = withoutSkillRecords[index];
        const withSkill = withSkillRecords[index];

        expect(withoutSkill.promptIndex).toBe(withSkill.promptIndex);
        expect(withoutSkill.prompt).toBe(withSkill.prompt);

        const scenarioContext = getScenarioContext(withoutSkill.prompt, withoutSkill.promptIndex);
        const withoutSkillScores = await scoreRun(
          agent,
          withoutSkill.prompt,
          scenarioContext,
          "without skill",
          withoutSkill,
          sampleCount
        );
        const withSkillScores = await scoreRun(
          agent,
          withSkill.prompt,
          scenarioContext,
          "with skill",
          withSkill,
          sampleCount
        );

        appendJsonl(REPORT_PATH, {
          prompt: withoutSkill.prompt,
          "without-skill tokens": getTokenCount(withoutSkill),
          "without-skill groundedness score": withoutSkillScores.groundednessScore,
          "without-skill root cause analysis score": withoutSkillScores.rootCauseAnalysisScore,
          "with-skill tokens": getTokenCount(withSkill),
          "with-skill groundedness score": withSkillScores.groundednessScore,
          "with-skill root cause analysis score": withSkillScores.rootCauseAnalysisScore
        });

        console.warn(`Raw response evaluation appended to ${REPORT_PATH} (${index + 1}/${rowLimit})`);
      }

      expect(rowLimit).toBeGreaterThan(0);
      expect(sampleCount).toBeGreaterThan(0);
    });
  }, TEST_TIMEOUT_MS);
});