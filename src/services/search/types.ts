import type {
  DatePostedRange,
  JobLocationType,
  JobType,
  SearchProvider,
  SearchWebsite,
} from "../../generated/prisma/enums.js";

export interface ApplyOption {
  publisher: string;
  url: string;
  isDirect: boolean;
  website: SearchWebsite;
}

/** The common job shape every search provider is converted to. */
export interface NormalizedJob {
  externalId: string;
  provider: SearchProvider;
  positionName: string;
  companyName: string;
  companyWebsite: string | null;
  description: string;
  location: string | null;
  jobType: JobType;
  locationType: JobLocationType;
  postedAt: Date | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  applyOptions: ApplyOption[];
}

export interface SearchParams {
  query: string;
  location?: string | null;
  country: string;
  datePosted: DatePostedRange;
  remoteOnly: boolean;
  jobTypes: JobType[];
  maxResults: number;
}

export interface SearchContext {
  userId: string;
  requestId?: string;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: SearchProvider,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(`${provider}: ${message}`);
  }
}
