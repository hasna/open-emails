// Public API — types
export type {
  Provider,
  ProviderType,
  CreateProviderInput,
  Domain,
  DnsStatus,
  DnsRecord,
  EmailAddress,
  CreateAddressInput,
  Attachment,
  SendEmailOptions,
  Email,
  EmailStatus,
  EmailEvent,
  EventType,
  Stats,
  EmailFilter,
  EventFilter,
} from "./types/index.js";

export {
  ProviderNotFoundError,
  DomainNotFoundError,
  AddressNotFoundError,
  EmailNotFoundError,
  ProviderConfigError,
} from "./types/index.js";

// DB functions
export {
  createProvider,
  getProvider,
  listProviders,
  updateProvider,
  deleteProvider,
  getActiveProvider,
} from "./db/providers.js";

export {
  createDomain,
  getDomain,
  getDomainByName,
  listDomains,
  updateDomain,
  deleteDomain,
  updateDnsStatus,
} from "./db/domains.js";

export {
  createAddress,
  getAddress,
  getAddressByEmail,
  listAddresses,
  updateAddress,
  deleteAddress,
  markVerified,
} from "./db/addresses.js";

export {
  createEmail,
  getEmail,
  listEmails,
  updateEmailStatus,
  deleteEmail,
} from "./db/emails.js";

export {
  createEvent,
  listEvents,
  getEventsByEmail,
  upsertEvent,
} from "./db/events.js";

// Database utilities
export { getDatabase, closeDatabase, resetDatabase, uuid, now, resolvePartialId } from "./db/database.js";

// Lib functions
export { getLocalStats, formatStatsTable } from "./lib/stats.js";
export { generateSpfRecord, generateDmarcRecord, formatDnsTable } from "./lib/dns.js";
export { syncProvider, syncAll } from "./lib/sync.js";

// Provider factory
export { getAdapter } from "./providers/index.js";
export type { ProviderAdapter, RemoteDomain, RemoteAddress, RemoteEvent } from "./providers/interface.js";
