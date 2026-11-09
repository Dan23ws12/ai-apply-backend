import type { ApplicantForAi } from "../services/ai.client.js";
import type { DetectedField } from "./fieldDetector.js";

/**
 * Answers common fields straight from the user's profile (no AI call needed).
 * Returns undefined when the field is not a standard profile field.
 */
const RULES: { test: RegExp; value: (a: ApplicantForAi) => string | null | undefined }[] = [
  { test: /\b(first|given)[\s_-]*name\b|^fname$/i, value: (a) => a.first_name },
  { test: /\b(last|family|sur)[\s_-]*name\b|^lname$/i, value: (a) => a.last_name },
  { test: /^(full[\s_-]*)?name$|\bfull name\b|\byour name\b/i, value: (a) => `${a.first_name} ${a.last_name}` },
  { test: /e-?mail/i, value: (a) => a.email },
  { test: /phone|mobile|telephone/i, value: (a) => a.phone },
  { test: /linkedin/i, value: (a) => a.linkedin_url },
  { test: /github/i, value: (a) => a.github_url },
  { test: /portfolio|personal (web)?site|^website$/i, value: (a) => a.portfolio_url },
  { test: /\bcity\b/i, value: (a) => a.city },
  { test: /province|state|region/i, value: (a) => a.region },
  { test: /^country$|\bcountry of residence\b/i, value: (a) => a.country },
  { test: /^location$|current location|where are you (located|based)/i, value: (a) => [a.city, a.region, a.country].filter(Boolean).join(", ") },
  { test: /years of (professional )?experience/i, value: (a) => (a.years_of_experience != null ? String(a.years_of_experience) : null) },
  { test: /salary|compensation expectation/i, value: (a) => a.desired_salary },
  { test: /notice period|when can you start|start date availability/i, value: (a) => a.notice_period },
];

export function profileValue(field: DetectedField, applicant: ApplicantForAi): string | undefined {
  if (["file", "checkbox", "radio", "password"].includes(field.kind)) return undefined;
  const label = `${field.label} ${field.name}`.trim();
  for (const rule of RULES) {
    if (rule.test.test(field.label) || rule.test.test(field.name)) {
      const v = rule.value(applicant);
      if (v) return v;
    }
  }
  // User-defined answers in profile.extraAnswers, matched on the label text.
  for (const [question, answer] of Object.entries(applicant.extra_answers ?? {})) {
    if (label.toLowerCase().includes(question.toLowerCase())) return answer;
  }
  return undefined;
}

export function fileKind(field: DetectedField, fileFieldCount: number): "resume" | "coverLetter" | undefined {
  const label = `${field.label} ${field.name}`.toLowerCase();
  if (/cover/.test(label)) return "coverLetter";
  if (/resume|résumé|\bcv\b|curriculum/.test(label)) return "resume";
  return fileFieldCount === 1 ? "resume" : undefined;
}
