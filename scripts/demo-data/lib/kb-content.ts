import type { Rng } from "./rng";

export interface FolderSeed {
  path: string;
  rule?: { kind: "role"; role: "ADMIN" | "MEMBER" } | { kind: "appGrant"; app: string };
  keep?: boolean;
}

export const SEEDED_FOLDERS = ["Networking", "Servers", "Access Management", "Datacenter", "Procedures", "Troubleshooting", "Onboarding", "Tools"];

export const FOLDERS: readonly FolderSeed[] = [
  { path: "Networking/Firewalls", keep: true },
  { path: "Networking/Firewalls/FortiGate", keep: true },
  { path: "Networking/Firewalls/Palo Alto" },
  { path: "Networking/Wi-Fi", keep: true },
  { path: "Networking/Wi-Fi/Guest network" },
  { path: "Networking/VPN" },
  { path: "Servers/Linux", keep: true },
  { path: "Servers/Linux/Ubuntu" },
  { path: "Servers/Linux/RHEL" },
  { path: "Servers/Windows", keep: true },
  { path: "Servers/Windows/Active Directory" },
  { path: "Servers/Virtualization", keep: true },
  { path: "Servers/Virtualization/Proxmox" },
  { path: "Access Management/Okta", rule: { kind: "appGrant", app: "Okta" }, keep: true },
  { path: "Access Management/Offboarding" },
  { path: "Datacenter/BUE Datacenter", keep: true },
  { path: "Datacenter/BUE Datacenter/Racks" },
  { path: "Datacenter/Colocation", rule: { kind: "role", role: "ADMIN" }, keep: true },
  { path: "Procedures/Hardware lifecycle", keep: true },
  { path: "Procedures/Hardware lifecycle/Laptop refresh" },
  { path: "Procedures/Purchasing" },
  { path: "Troubleshooting/macOS" },
  { path: "Troubleshooting/Windows", keep: true },
  { path: "Troubleshooting/Windows/Printing" },
  { path: "Troubleshooting/Mobile" },
  { path: "Onboarding/Engineering", rule: { kind: "appGrant", app: "GitHub Enterprise" }, keep: true },
  { path: "Onboarding/Sales" },
  { path: "Tools/Scripts" },
  { path: "Security", rule: { kind: "role", role: "ADMIN" }, keep: true },
  { path: "Security/Incident response", keep: true },
  { path: "Security/Incident response/Playbooks", keep: true },
  { path: "Security/Incident response/Playbooks/Ransomware", keep: true },
  { path: "Security/Vulnerability management" },
  { path: "End-user Support", keep: true },
  { path: "End-user Support/How-to guides", keep: true },
  { path: "End-user Support/How-to guides/Collaboration" },
  { path: "End-user Support/FAQ" },
  { path: "Policies", rule: { kind: "role", role: "MEMBER" }, keep: true },
];

const TOPICS: Record<string, string[]> = {
  Networking: ["the core switches", "the office Wi-Fi", "the corporate VPN", "the DHCP scopes", "the DNS resolvers"],
  Firewalls: ["FortiGate 100F", "the PA-440 firewall", "the perimeter firewall", "the site-to-site tunnels"],
  "Wi-Fi": ["the Ubiquiti controller", "the guest SSID", "the 802.1X Wi-Fi", "the Aruba access points"],
  VPN: ["FortiClient VPN", "the always-on VPN", "split tunnelling"],
  Servers: ["the file server", "the backup server", "the monitoring host"],
  Linux: ["Ubuntu 24.04 servers", "RHEL 9 hosts", "systemd services", "the unattended-upgrades job"],
  Windows: ["Windows Server 2022", "Group Policy", "the print server", "WSUS"],
  "Active Directory": ["Active Directory", "the domain controllers", "AD Connect"],
  Virtualization: ["the Proxmox cluster", "VM templates", "Ceph storage"],
  "Access Management": ["Okta", "the access review process", "shared mailboxes", "service accounts"],
  Okta: ["Okta MFA", "Okta group rules", "Okta SCIM provisioning"],
  Offboarding: ["the offboarding checklist", "account deprovisioning", "device recovery"],
  Datacenter: ["the BUE datacenter", "rack power", "the cooling units", "the colocation cage"],
  Procedures: ["the change calendar", "the purchasing flow", "asset tagging", "the on-call rotation"],
  "Hardware lifecycle": ["laptop refresh", "device wipes", "the e-waste pickup", "warranty claims"],
  Troubleshooting: ["slow logins", "certificate errors", "sync conflicts", "Bluetooth pairing"],
  macOS: ["macOS Sonoma", "FileVault", "Jamf enrolment", "Time Machine"],
  Printing: ["the office printers", "follow-me printing", "the HP LaserJet fleet"],
  Mobile: ["iPhone enrolment", "Android work profiles", "eSIM activation"],
  Onboarding: ["new hire laptops", "the first-day checklist", "account creation"],
  Engineering: ["GitHub Enterprise", "the developer VPN", "AWS SSO", "local dev environments"],
  Sales: ["Salesforce", "the demo laptops", "Zoom webinars"],
  Tools: ["the PowerShell toolkit", "the inventory script", "the label printer"],
  Security: ["CrowdStrike Falcon", "phishing reports", "the vulnerability scanner", "1Password"],
  "Incident response": ["a compromised account", "a lost laptop", "a phishing campaign"],
  Ransomware: ["ransomware containment", "backup restore after ransomware", "isolating infected hosts"],
  "End-user Support": ["Google Workspace", "Slack", "Zoom", "the self-service portal"],
  Collaboration: ["Google Drive", "Slack huddles", "shared calendars", "Confluence spaces"],
  FAQ: ["passwords", "Wi-Fi access", "new equipment", "software requests"],
  Policies: ["acceptable use", "password rotation", "device return", "remote work equipment"],
};

const ACTIONS = [
  "reset MFA for a user", "rotate the admin credentials", "add a new site", "request a license", "set up on a new laptop",
  "export the audit logs", "enable SSO", "grant temporary access", "migrate to the new tenant", "configure alerting",
  "back up the configuration", "renew the certificate", "decommission", "onboard a contractor", "upgrade the firmware",
  "audit the access list", "recover a deleted item", "configure the fallback", "document a change", "test the failover",
];
const SYMPTOMS = [
  "intermittent disconnects", "slow performance", "authentication loops", "error 403 on sign-in", "missing permissions",
  "high CPU alerts", "certificate warnings", "duplicate entries", "timeouts after the upgrade", "stale DNS records",
  "blank screen after login", "sync stuck at 99%",
];
const OPERATIONS = [
  "monthly patching", "emergency rollback", "capacity expansion", "quarterly restore test", "planned maintenance",
  "certificate renewal", "disaster recovery drill", "credential rotation", "hardware replacement",
];
const REFERENCES = ["configuration reference", "escalation contacts", "naming conventions", "port matrix", "known limitations", "IP plan"];

export type ArticleKind = "howto" | "troubleshoot" | "runbook" | "reference" | "checklist" | "faq";

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function topicFor(folderPath: string, rng: Rng): string {
  const segments = folderPath.split("/").reverse();
  for (const segment of segments) {
    const list = TOPICS[segment];
    if (list) return rng.pick(list);
  }
  return rng.pick(TOPICS.Procedures!);
}

export function titleFor(kind: ArticleKind, topic: string, rng: Rng): string {
  switch (kind) {
    case "howto":
      return `How to ${rng.pick(ACTIONS)} in ${topic}`;
    case "troubleshoot":
      return rng.chance(0.5) ? `Troubleshooting ${rng.pick(SYMPTOMS)} with ${topic}` : `${cap(topic)}: fixing ${rng.pick(SYMPTOMS)}`;
    case "runbook":
      return `Runbook: ${rng.pick(OPERATIONS)} for ${topic}`;
    case "reference":
      return `${cap(topic)} ${rng.pick(REFERENCES)}`;
    case "checklist":
      return `${rng.pick(["Pre-change", "Go-live", "Handover", "Weekly", "Audit"])} checklist for ${topic}`;
    case "faq":
      return `FAQ: ${topic}${rng.chance(0.5) ? ` for ${rng.pick(["new hires", "managers", "contractors", "the help desk"])}` : ""}`;
  }
}

const CODE = [
  ["bash", "sudo systemctl status nginx\nsudo journalctl -u nginx --since \"1 hour ago\" | tail -n 50"],
  ["powershell", "Get-ADUser -Identity jdoe -Properties LockedOut | Select-Object Name, LockedOut\nUnlock-ADAccount -Identity jdoe"],
  ["yaml", "vlan:\n  id: 120\n  name: corp-wifi\n  dhcp_scope: 10.20.120.0/24\n  dns: [10.20.0.10, 10.20.0.11]"],
  ["bash", "openssl s_client -connect vpn.acme-demo.test:443 -servername vpn.acme-demo.test </dev/null \\\n  | openssl x509 -noout -dates"],
  ["sql", "SELECT hostname, last_seen\nFROM inventory\nWHERE last_seen < now() - interval '30 days'\nORDER BY last_seen;"],
  ["powershell", "Get-Printer -ComputerName print01 | Where-Object PrinterStatus -ne 'Normal'"],
] as const;

export function bodyFor(kind: ArticleKind, title: string, topic: string, rng: Rng, seeAlso?: string): string {
  const [lang, code] = rng.pick(CODE);
  const owner = rng.pick(["IT Operations", "the Service Desk", "the Network team", "Security", "the Platform team"]);
  const steps = rng.sample(
    [
      `Open the admin console for ${topic} and sign in with your admin account.`,
      "Confirm the change window in the change calendar.",
      "Take a screenshot of the current settings and attach it to the ticket.",
      "Apply the change on one site first and wait 15 minutes.",
      "Check the monitoring dashboard for new alerts.",
      "Roll the change out to the remaining sites.",
      "Update the asset record and the ticket with what changed.",
      "Notify the requester and close the ticket.",
    ],
    rng.int(4, 7),
  );
  const parts = [
    `# ${title}`,
    "",
    `This ${kind === "runbook" ? "runbook" : "article"} covers ${topic}. It is maintained by ${owner} and was last reviewed during the ${rng.pick(["Q1", "Q2", "Q3", "Q4"])} audit.`,
    "",
    "## Before you start",
    "",
    ...rng.sample(["Admin access to the console", "A ticket number for the change", "The asset tag of the affected device", "A maintenance window approved by the owner", "VPN connected if you are remote"], rng.int(2, 4)).map((x) => `- ${x}`),
    "",
    kind === "faq" ? "## Questions" : "## Steps",
    "",
    ...(kind === "faq"
      ? steps.map((s, i) => `**Q${i + 1}. ${s.replace(/\.$/, "?")}**\n\nYes. ${rng.pick(["Ask the Service Desk if unsure.", "This is covered by the standard change.", "Only admins can do this."])}\n`)
      : steps.map((s, i) => `${i + 1}. ${s}`)),
    "",
    "```" + lang,
    code,
    "```",
    "",
    "| Setting | Value | Notes |",
    "| --- | --- | --- |",
    `| Owner | ${owner} | Escalate after 30 minutes |`,
    `| Review cycle | ${rng.pick(["Monthly", "Quarterly", "Yearly"])} | Tracked in the audit log |`,
    `| Severity if broken | ${rng.pick(["P1", "P2", "P3"])} | See the incident matrix |`,
    "",
    `> **Note:** ${rng.pick(["Never share admin credentials over chat.", "Changes outside the window need CAB approval.", "Keep the rollback plan in the ticket.", "This applies to every site except Madrid."])}`,
  ];
  if (kind === "troubleshoot" || kind === "runbook") {
    parts.push("", "## Rollback", "", "If the checks fail, restore the previous configuration from the backup taken in step 1 and page the on-call engineer.");
  }
  if (seeAlso) parts.push("", `See also [[${seeAlso}]].`);
  return parts.join("\n");
}
