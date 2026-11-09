import { prisma } from "../lib/prisma.js";
import type { ApplicantForAi, JobForAi } from "./ai.client.js";
import type { Company, JobApplyOption, JobPosting } from "../generated/prisma/client.js";

/** Builds the applicant details sent to the AI and used to fill forms. */
export async function loadApplicant(userId: string): Promise<ApplicantForAi> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } });
  const p = user.profile;
  return {
    first_name: user.firstName,
    last_name: user.lastName,
    email: user.email,
    phone: p?.phone,
    city: p?.city,
    region: p?.region,
    country: p?.country,
    linkedin_url: p?.linkedinUrl,
    github_url: p?.githubUrl,
    portfolio_url: p?.portfolioUrl,
    work_authorization: p?.workAuthorization,
    requires_sponsorship: p?.requiresSponsorship,
    years_of_experience: p?.yearsOfExperience,
    desired_salary: p?.desiredSalary,
    notice_period: p?.noticePeriod,
    extra_answers: (p?.extraAnswers as Record<string, string> | null) ?? null,
  };
}

type PostingWithCompany = JobPosting & { company: Company | null };

/**
 * The posting as the fraud check sees it. Uses only posting facts (never a user's choices),
 * because the fraud rating is stored once per posting for everyone: the apply link is the
 * company's own page when there is one, otherwise the first link the API returned.
 */
export function postingForAi(posting: PostingWithCompany & { applyOptions: JobApplyOption[] }): JobForAi {
  const link = posting.applyOptions.find((o) => o.isDirect) ?? posting.applyOptions[0];
  return {
    title: posting.positionName,
    company: posting.company?.name ?? posting.companyName,
    company_website: posting.company?.websiteUrl ?? null,
    description: posting.description ?? "",
    location: posting.location,
    apply_url: link?.url ?? null,
    publisher: link ? link.publisher || link.website : null,
  };
}

/** The posting plus this user's chosen apply link (for documents and form answers). */
export function jobForAi(app: {
  posting: PostingWithCompany;
  applyOption: JobApplyOption;
  searchWebsite: string;
}): JobForAi {
  const p = app.posting;
  return {
    title: p.positionName,
    company: p.company?.name ?? p.companyName,
    company_website: p.company?.websiteUrl ?? null,
    description: p.description ?? "",
    location: p.location,
    apply_url: app.applyOption.url,
    publisher: app.searchWebsite,
  };
}
