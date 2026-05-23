import { Value } from "@sinclair/typebox/value";
import { ProposalSetSchema, type ProposalSet } from "./types.js";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export function parseProposals(raw: unknown): ProposalSet {
  if (!Value.Check(ProposalSetSchema, raw)) {
    const errors = [...Value.Errors(ProposalSetSchema, raw)];
    const detail = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new ParseError(`Invalid proposal schema: ${detail}`);
  }
  return raw;
}
