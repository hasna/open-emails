import chalk from "chalk";
import { getDatabase } from "../db/database.js";
import type { Database } from "../db/database.js";

export interface AnalyticsData {
  dailyVolume: { date: string; count: number }[];
  topRecipients: { email: string; count: number }[];
  busiestHours: { hour: number; count: number }[];
  deliveryTrend: { date: string; sent: number; delivered: number; bounced: number }[];
}

export function getAnalytics(providerId?: string, period = "30d", db?: Database): AnalyticsData {
  const d = db || getDatabase();
  const days = parseInt(period) || 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Daily volume
  const volumeParams: any[] = [since];
  let volumeWhere = "WHERE sent_at >= ?";
  if (providerId) {
    volumeWhere += " AND provider_id = ?";
    volumeParams.push(providerId);
  }
  const dailyVolume = d
    .query(`SELECT date(sent_at) as date, COUNT(*) as count FROM emails ${volumeWhere} GROUP BY date(sent_at) ORDER BY date`)
    .all(...volumeParams) as { date: string; count: number }[];

  // Top recipients: parse to_addresses JSON, count frequency, top 10
  const emailRows = d
    .query(`SELECT to_addresses FROM emails ${volumeWhere}`)
    .all(...volumeParams) as { to_addresses: string }[];

  const recipientCounts = new Map<string, number>();
  for (const row of emailRows) {
    try {
      const addresses = JSON.parse(row.to_addresses || "[]") as string[];
      for (const addr of addresses) {
        recipientCounts.set(addr, (recipientCounts.get(addr) || 0) + 1);
      }
    } catch {
      // skip malformed JSON
    }
  }
  const topRecipients = Array.from(recipientCounts.entries())
    .map(([email, count]) => ({ email, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Busiest hours
  const busiestHours = d
    .query(
      `SELECT cast(strftime('%H', sent_at) as integer) as hour, COUNT(*) as count FROM emails ${volumeWhere} GROUP BY hour ORDER BY hour`,
    )
    .all(...volumeParams) as { hour: number; count: number }[];

  // Delivery trend: count emails sent per day, join with events for delivered/bounced
  const trendParams: any[] = [since];
  let trendProviderFilter = "";
  if (providerId) {
    trendProviderFilter = " AND e.provider_id = ?";
    trendParams.push(providerId);
  }
  const sentByDay = d
    .query(
      `SELECT date(sent_at) as date, COUNT(*) as sent FROM emails ${volumeWhere} GROUP BY date(sent_at) ORDER BY date`,
    )
    .all(...volumeParams) as { date: string; sent: number }[];

  const deliveredByDay = d
    .query(
      `SELECT date(ev.occurred_at) as date, COUNT(*) as count FROM events ev JOIN emails e ON ev.email_id = e.id WHERE ev.type = 'delivered' AND ev.occurred_at >= ?${trendProviderFilter} GROUP BY date(ev.occurred_at)`,
    )
    .all(...trendParams) as { date: string; count: number }[];

  const bouncedByDay = d
    .query(
      `SELECT date(ev.occurred_at) as date, COUNT(*) as count FROM events ev JOIN emails e ON ev.email_id = e.id WHERE ev.type = 'bounced' AND ev.occurred_at >= ?${trendProviderFilter} GROUP BY date(ev.occurred_at)`,
    )
    .all(...trendParams) as { date: string; count: number }[];

  const deliveredMap = new Map(deliveredByDay.map((r) => [r.date, r.count]));
  const bouncedMap = new Map(bouncedByDay.map((r) => [r.date, r.count]));

  const deliveryTrend = sentByDay.map((row) => ({
    date: row.date,
    sent: row.sent,
    delivered: deliveredMap.get(row.date) || 0,
    bounced: bouncedMap.get(row.date) || 0,
  }));

  return { dailyVolume, topRecipients, busiestHours, deliveryTrend };
}

export function formatAnalytics(data: AnalyticsData): string {
  let output = "";

  // Daily volume - ASCII bar chart
  output += chalk.bold("\n  Daily Send Volume\n");
  if (data.dailyVolume.length === 0) {
    output += "  No data\n";
  } else {
    const maxCount = Math.max(...data.dailyVolume.map((d) => d.count), 1);
    for (const day of data.dailyVolume.slice(-14)) {
      const barLen = Math.round((day.count / maxCount) * 40);
      const bar = chalk.blue("\u2588".repeat(barLen));
      output += `  ${day.date}  ${bar} ${day.count}\n`;
    }
  }

  // Top recipients
  output += chalk.bold("\n  Top Recipients\n");
  if (data.topRecipients.length === 0) {
    output += "  No data\n";
  } else {
    for (const r of data.topRecipients.slice(0, 10)) {
      output += `  ${r.email}  ${chalk.gray(`(${r.count} emails)`)}\n`;
    }
  }

  // Busiest hours
  output += chalk.bold("\n  Busiest Hours\n");
  if (data.busiestHours.length === 0) {
    output += "  No data\n";
  } else {
    const maxHour = Math.max(...data.busiestHours.map((h) => h.count), 1);
    for (const h of data.busiestHours) {
      const barLen = Math.round((h.count / maxHour) * 30);
      const bar = chalk.cyan("\u2588".repeat(barLen));
      output += `  ${String(h.hour).padStart(2, "0")}:00  ${bar} ${h.count}\n`;
    }
  }

  // Delivery trend
  output += chalk.bold("\n  Delivery Trend (last 7 days)\n");
  if (data.deliveryTrend.length === 0) {
    output += "  No data\n";
  } else {
    for (const d of data.deliveryTrend.slice(-7)) {
      const total = d.sent || 1;
      const rate = ((d.delivered / total) * 100).toFixed(1);
      const rateColor = parseFloat(rate) > 95 ? chalk.green : parseFloat(rate) > 80 ? chalk.yellow : chalk.red;
      output += `  ${d.date}  sent:${d.sent} delivered:${d.delivered} bounced:${d.bounced}  ${rateColor(rate + "%")}\n`;
    }
  }

  return output;
}
