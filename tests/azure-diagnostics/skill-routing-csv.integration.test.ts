/**
 * CSV skill routing report for azure-diagnostics prompts.
 *
 * Runs five sample diagnostics prompts against a real Copilot agent session and
 * emits a CSV with the invoked skill routing result for each prompt.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
    useAgentRunner,
    shouldSkipIntegrationTests,
    getIntegrationSkipReason
} from "../utils/agent-runner";
import { getToolCalls, isSkillInvoked, withTestResult } from "../utils/evaluate";

const SKILL_NAME = "azure-diagnostics";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPTS_FILE = path.join(__dirname, "skill-routing-prompts.txt");

interface CsvRow {
    prompt: string;
    diagnosticsInvoked: "Yes" | "No";
    alternateSkill: string;
}

const skipTests = shouldSkipIntegrationTests();
const skipReason = getIntegrationSkipReason();

if (skipTests && skipReason) {
    console.log(`Skipping integration tests: ${skipReason}`);
}

const describeIntegration = skipTests ? describe.skip : describe;

function getInvokedSkillName(agentMetadata: Parameters<typeof getToolCalls>[0]): string | undefined {
    return getToolCalls(agentMetadata, "skill")
        .map(event => {
            const serializedArgs = JSON.stringify(event.data.arguments ?? {});
            return serializedArgs.match(/"skill"\s*:\s*"([^"]+)"/)?.[1];
        })
        .find((skillName): skillName is string => Boolean(skillName));
}

function shouldEarlyTerminateOnSkillInvocation(agentMetadata: Parameters<typeof getToolCalls>[0]): boolean {
    return Boolean(getInvokedSkillName(agentMetadata));
}

function readPromptsFromFile(filePath: string): string[] {
    return fs
        .readFileSync(filePath, "utf-8")
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
}

function toCsvCell(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function toCsv(rows: CsvRow[]): string {
    const header = [
        "prompt",
        "azure-diagnostics invoked",
        "skill invoked if not azure-diagnostics"
    ].join(",");

    const csvRows = rows.map(row => [
        toCsvCell(row.prompt),
        row.diagnosticsInvoked,
        row.alternateSkill
    ].join(","));

    return [header, ...csvRows].join("\n");
}

function writeCsv(reportPath: string, rows: CsvRow[]): string {
    const csv = toCsv(rows);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, csv, "utf-8");
    return csv;
}

describeIntegration(`${SKILL_NAME}_ - Skill Routing CSV`, () => {
    const agent = useAgentRunner();

    test("outputs prompt routing results as csv", async () => {
        await withTestResult(async ({ setSkillInvocationRate }) => {
            const diagnosticsPrompts = readPromptsFromFile(PROMPTS_FILE);
            const reportPath = path.join("reports", "azure-diagnostics-skill-routing.csv");
            const rows: CsvRow[] = [];

            writeCsv(reportPath, rows);

            for (const prompt of diagnosticsPrompts) {
                const agentMetadata = await agent.run({
                    prompt,
                    shouldEarlyTerminate: shouldEarlyTerminateOnSkillInvocation
                });
                const diagnosticsInvoked = isSkillInvoked(agentMetadata, SKILL_NAME);
                const invokedSkill = getInvokedSkillName(agentMetadata);
                const alternateSkill = diagnosticsInvoked
                    ? "N/A"
                    : invokedSkill ?? "No skill invoked";

                rows.push({
                    prompt,
                    diagnosticsInvoked: diagnosticsInvoked ? "Yes" : "No",
                    alternateSkill
                });

                writeCsv(reportPath, rows);
                console.warn(`CSV updated at ${reportPath} (${rows.length}/${diagnosticsPrompts.length})`);
            }

            setSkillInvocationRate(
                rows.filter(row => row.diagnosticsInvoked === "Yes").length / diagnosticsPrompts.length
            );

            const csv = toCsv(rows);

            console.warn(`\n${csv}\n`);
            console.warn(`CSV written to ${reportPath}`);

            expect(rows).toHaveLength(diagnosticsPrompts.length);
            expect(diagnosticsPrompts.length).toBeGreaterThan(0);
        });
    });
});