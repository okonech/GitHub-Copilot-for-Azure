#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_INPUT = path.resolve(__dirname, "../azure-diagnostics/azure-diagnostics-raw-response-evaluation.jsonl");

const HEADERS = [
  "row",
  "prompt",
  "without-skill tokens",
  "without-skill groundedness score",
  "without-skill root cause analysis score",
  "with-skill tokens",
  "with-skill groundedness score",
  "with-skill root cause analysis score",
  "groundedness uplift with skill (with - without)",
  "root cause analysis uplift with skill (with - without)",
  "token change with skill (with - without)"
];

function parseArgs(argv) {
  const args = argv.slice(2);
  let input = DEFAULT_INPUT;
  let output;

  for (let index = 0; index < args.length; index++) {
    if ((args[index] === "--input" || args[index] === "-i") && args[index + 1]) {
      input = path.resolve(args[++index]);
      continue;
    }

    if ((args[index] === "--output" || args[index] === "-o") && args[index + 1]) {
      output = path.resolve(args[++index]);
      continue;
    }

    if (args[index] === "--help" || args[index] === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${args[index]}`);
  }

  return {
    input,
    output: output ?? input.replace(/\.jsonl$/i, ".csv")
  };
}

function printUsage() {
  console.log(`Usage: node scripts/convert-raw-response-evaluation-to-csv.js [--input <jsonl>] [--output <csv>]

Defaults:
  --input  ${DEFAULT_INPUT}
  --output <input with .csv extension>`);
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Failed to parse JSONL line ${index + 1}: ${error.message}`);
      }
    });
}

function csvCell(value) {
  if (value === undefined || value === null) {
    return "";
  }

  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function scoreDelta(record, withKey, withoutKey) {
  return Number(record[withKey] ?? 0) - Number(record[withoutKey] ?? 0);
}

function toCsv(records) {
  const rows = records.map((record, index) => ({
    row: index + 1,
    prompt: record.prompt,
    "without-skill tokens": record["without-skill tokens"],
    "without-skill groundedness score": record["without-skill groundedness score"],
    "without-skill root cause analysis score": record["without-skill root cause analysis score"],
    "with-skill tokens": record["with-skill tokens"],
    "with-skill groundedness score": record["with-skill groundedness score"],
    "with-skill root cause analysis score": record["with-skill root cause analysis score"],
    "groundedness uplift with skill (with - without)": scoreDelta(
      record,
      "with-skill groundedness score",
      "without-skill groundedness score"
    ),
    "root cause analysis uplift with skill (with - without)": scoreDelta(
      record,
      "with-skill root cause analysis score",
      "without-skill root cause analysis score"
    ),
    "token change with skill (with - without)": scoreDelta(record, "with-skill tokens", "without-skill tokens")
  }));

  return [
    HEADERS.map(csvCell).join(","),
    ...rows.map(row => HEADERS.map(header => csvCell(row[header])).join(","))
  ].join("\n");
}

function main() {
  const { input, output } = parseArgs(process.argv);
  const records = readJsonl(input);
  const csv = toCsv(records);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${csv}\n`, "utf-8");

  console.log(`Wrote ${records.length} rows to ${output}`);
}

main();