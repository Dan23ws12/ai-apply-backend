import { prisma } from "../lib/prisma.js";
import type { ApplicantForAi, JobForAi } from "./ai.client.js";
import type { Company, Job } from "../generated/prisma/client.js";

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

export function jobForAi(job: Job & { company: Company }): JobForAi {
  return {
    title: job.positionName,
    company: job.company.name,
    company_website: job.company.websiteUrl,
    description: job.description ?? "",
    location: job.location,
    apply_url: job.applicationLink,
    publisher: job.searchWebsite,
  };
}
