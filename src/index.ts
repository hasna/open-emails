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
  searchEmails,
  updateEmailStatus,
  deleteEmail,
} from "./db/emails.js";

export {
  createEvent,
  listEvents,
  getEventsByEmail,
  upsertEvent,
} from "./db/events.js";

export { storeEmailContent, getEmailContent } from "./db/email-content.js";

export {
  upsertContact, getContact, listContacts, suppressContact,
  unsuppressContact, incrementSendCount, incrementBounceCount,
  incrementComplaintCount, isContactSuppressed,
} from "./db/contacts.js";

export {
  createTemplate, getTemplate, getTemplateByName, listTemplates,
  deleteTemplate, renderTemplate,
} from "./db/templates.js";

export {
  createGroup, getGroup, getGroupByName, listGroups, deleteGroup,
  addMember, removeMember, listMembers, getMemberCount,
} from "./db/groups.js";

export {
  createScheduledEmail, listScheduledEmails, getScheduledEmail,
  cancelScheduledEmail, getDueEmails, markSent, markFailed,
} from "./db/scheduled.js";

export {
  storeSandboxEmail, listSandboxEmails, getSandboxEmail,
  clearSandboxEmails, getSandboxCount,
} from "./db/sandbox.js";

// Database utilities
export { getDatabase, closeDatabase, resetDatabase, uuid, now, resolvePartialId } from "./db/database.js";

// Lib functions
export { getLocalStats, formatStatsTable } from "./lib/stats.js";
export { generateSpfRecord, generateDmarcRecord, formatDnsTable } from "./lib/dns.js";
export { syncProvider, syncAll } from "./lib/sync.js";
export { getAnalytics, formatAnalytics } from "./lib/analytics.js";
export { parseCsv, batchSend } from "./lib/batch.js";
export { checkDnsRecords, formatDnsCheck } from "./lib/dns-check.js";
export { runDiagnostics, formatDiagnostics } from "./lib/doctor.js";
export { exportEmailsCsv, exportEmailsJson, exportEventsCsv, exportEventsJson } from "./lib/export.js";
export { loadConfig, saveConfig, getConfigValue, setConfigValue, getDefaultProviderId } from "./lib/config.js";
export { checkProviderHealth, checkAllProviders, formatProviderHealth } from "./lib/health.js";
export { log, setLogLevel } from "./lib/logger.js";
export { colorStatus, colorDnsStatus, truncate, formatDate } from "./lib/format.js";

// Provider factory
export { getAdapter } from "./providers/index.js";
export type { ProviderAdapter, RemoteDomain, RemoteAddress, RemoteEvent } from "./providers/interface.js";
