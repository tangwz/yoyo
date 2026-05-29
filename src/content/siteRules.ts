import type { SiteRules } from "@/storage/defaults";

const siteRuleBlockReason = "This site is disabled in Yoyo site blacklist.";

function normalizePattern(pattern: string): string {
  return pattern.trim().toLowerCase().replace(/\/+$/, "");
}

function matchesUrlPrefix(url: URL, pattern: string): boolean {
  return url.href.toLowerCase().replace(/\/+$/, "").startsWith(pattern);
}

function matchesWildcardHost(hostname: string, pattern: string): boolean {
  if (!pattern.startsWith("*.")) {
    return false;
  }

  const suffix = pattern.slice(2);
  return hostname !== suffix && hostname.endsWith(`.${suffix}`);
}

function matchesExactHost(hostname: string, pattern: string): boolean {
  return (
    !pattern.includes("/") &&
    (hostname === pattern || hostname.endsWith(`.${pattern}`))
  );
}

export function isUrlBlockedBySiteRules(url: string, rules: SiteRules): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  return rules.blacklist.some((rawPattern) => {
    const pattern = normalizePattern(rawPattern);
    if (!pattern) {
      return false;
    }

    if (pattern.startsWith("http://") || pattern.startsWith("https://")) {
      return matchesUrlPrefix(parsedUrl, pattern);
    }

    return matchesWildcardHost(hostname, pattern) || matchesExactHost(hostname, pattern);
  });
}

export function getSiteRuleBlockReason(): string {
  return siteRuleBlockReason;
}
