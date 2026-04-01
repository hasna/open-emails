import type { Stats } from "../types/index.js";
import { listEvents } from "../db/events.js";
import type { Database } from "../db/database.js";

export function getLocalStats(providerId?: string, period = "30d", db?: Database): Stats {
  const days = parseInt(period.replace("d", ""), 10) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const events = listEvents(
    {
      provider_id: providerId,
      since,
      limit: 10000,
    },
    db,
  );

  const sent = events.length;
  const delivered = events.filter((e) => e.type === "delivered").length;
  const bounced = events.filter((e) => e.type === "bounced").length;
  const complained = events.filter((e) => e.type === "complained").length;
  const opened = events.filter((e) => e.type === "opened").length;
  const clicked = events.filter((e) => e.type === "clicked").length;

  return {
    provider_id: providerId ?? "all",
    period,
    sent,
    delivered,
    bounced,
    complained,
    opened,
    clicked,
    delivery_rate: sent > 0 ? Math.round((delivered / sent) * 100 * 10) / 10 : 0,
    bounce_rate: sent > 0 ? Math.round((bounced / sent) * 100 * 10) / 10 : 0,
    open_rate: delivered > 0 ? Math.round((opened / delivered) * 100 * 10) / 10 : 0,
  };
}

export function formatStatsTable(stats: Stats): string {
  const lines = [
    `Provider: ${stats.provider_id}   Period: ${stats.period}`,
    ``,
    `  Sent:         ${stats.sent}`,
    `  Delivered:    ${stats.delivered}  (${stats.delivery_rate.toFixed(1)}%)`,
    `  Bounced:      ${stats.bounced}  (${stats.bounce_rate.toFixed(1)}%)`,
    `  Complained:   ${stats.complained}`,
    `  Opened:       ${stats.opened}  (${stats.open_rate.toFixed(1)}%)`,
    `  Clicked:      ${stats.clicked}`,
  ];
  return lines.join("\n") + "\n";
}
