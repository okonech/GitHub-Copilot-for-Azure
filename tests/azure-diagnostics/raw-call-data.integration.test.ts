/**
 * Raw call data capture for azure-diagnostics prompts.
 *
 * Runs prompts against a real Copilot agent session through completion and
 * appends one JSON record per prompt to a report file.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  useAgentRunner,
  shouldSkipIntegrationTests,
  getIntegrationSkipReason
} from "../utils/agent-runner";
import { getAllAssistantMessages, getToolCalls, withTestResult } from "../utils/evaluate";

const SKILL_NAME = "azure-diagnostics";
const TEST_TIMEOUT_MS = 60 * 60 * 1000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPTS_FILE = path.join(__dirname, "raw-call-data-prompts.txt");
const REPORT_PATH = path.join("reports", "azure-diagnostics-raw-call-data.jsonl");

type AgentMetadata = Parameters<typeof getAllAssistantMessages>[0];

const skipTests = shouldSkipIntegrationTests();
const skipReason = getIntegrationSkipReason();

if (skipTests && skipReason) {
  console.log(`Skipping integration tests: ${skipReason}`);
}

const describeIntegration = skipTests ? describe.skip : describe;

function readPromptsFromFile(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
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

  if (lastMessageId) {
    return messages.get(lastMessageId) ?? "";
  }

  return "";
}

function getInvokedSkillNames(agentMetadata: AgentMetadata): string[] {
  return getToolCalls(agentMetadata, "skill")
    .map(event => {
      const serializedArgs = JSON.stringify(event.data.arguments ?? {});
      return serializedArgs.match(/"skill"\s*:\s*"([^"]+)"/)?.[1];
    })
    .filter((skillName): skillName is string => Boolean(skillName));
}

function appendPromptRecord(reportPath: string, record: unknown): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.appendFileSync(reportPath, `${JSON.stringify(record)}\n`, "utf-8");
}

describeIntegration(`${SKILL_NAME}_ - Raw Call Data`, () => {
  const agent = useAgentRunner();

  test("captures raw call data for each prompt", async () => {
    await withTestResult(async ({ setSkillInvocationRate }) => {
      const prompts = readPromptsFromFile(PROMPTS_FILE);
      const rows: Array<{ diagnosticsInvoked: boolean }> = [];

      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, "", "utf-8");

      for (const [index, prompt] of prompts.entries()) {
        const startedAt = new Date().toISOString();
        const agentMetadata = await agent.run({
          prompt,
          nonInteractive: true
        });
        const completedAt = new Date().toISOString();
        const invokedSkillNames = getInvokedSkillNames(agentMetadata);
        const diagnosticsInvoked = invokedSkillNames.includes(SKILL_NAME);

        rows.push({ diagnosticsInvoked });

        appendPromptRecord(REPORT_PATH, {
          promptIndex: index + 1,
          promptCount: prompts.length,
          prompt,
          startedAt,
          completedAt,
          diagnosticsInvoked,
          invokedSkillNames,
          finalAssistantMessage: getFinalAssistantMessage(agentMetadata),
          allAssistantMessages: getAllAssistantMessages(agentMetadata),
          tokenUsage: agentMetadata.tokenUsage,
          rawEvents: agentMetadata.events
        });

        console.warn(`Raw call data appended to ${REPORT_PATH} (${index + 1}/${prompts.length})`);
      }

      setSkillInvocationRate(
        rows.filter(row => row.diagnosticsInvoked).length / prompts.length
      );

      console.warn(`Raw call data written to ${REPORT_PATH}`);

      expect(rows).toHaveLength(prompts.length);
      expect(prompts.length).toBeGreaterThan(0);
    });
  }, TEST_TIMEOUT_MS);
});