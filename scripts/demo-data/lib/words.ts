export const EMAIL_DOMAIN = "acme-demo.test";
export const COMPANIES = ["Acme Corp", "Acme Labs", "Acme Logistics"] as const;

export const FIRST_NAMES = [
  "Sofía", "Mateo", "Valentina", "Santiago", "Camila", "Benjamín", "Lucía", "Joaquín", "Martina", "Tomás",
  "Isabella", "Thiago", "Emilia", "Lautaro", "Catalina", "Facundo", "Julieta", "Nicolás", "Agustina", "Franco",
  "Florencia", "Gonzalo", "Micaela", "Ignacio", "Paula", "Federico", "Carolina", "Diego", "Antonella", "Matías",
  "Olivia", "Liam", "Emma", "Noah", "Ava", "Elijah", "Charlotte", "James", "Amelia", "William",
  "Mia", "Lucas", "Harper", "Henry", "Evelyn", "Alexander", "Abigail", "Daniel", "Ella", "Michael",
  "Grace", "Samuel", "Chloe", "David", "Zoe", "Joseph", "Nora", "Ethan", "Hannah", "Owen",
  "Laura", "Javier", "Marta", "Pablo", "Elena", "Sergio", "Irene", "Álvaro", "Cristina", "Raúl",
  "Nuria", "Adrián", "Pilar", "Rubén", "Silvia", "Hugo", "Beatriz", "Iván", "Rocío", "Marcos",
  "Aiko", "Kenji", "Mei", "Wei", "Priya", "Arjun", "Ananya", "Rohan", "Fatima", "Omar",
  "Leila", "Yusuf", "Ingrid", "Lars", "Freya", "Sven", "Chiara", "Luca", "Giulia", "Marco",
  "Amélie", "Louis", "Camille", "Hugo", "Léa", "Gabriel", "Anna", "Felix", "Lena", "Jonas",
  "Ana", "João", "Beatriz", "Rafael", "Larissa", "Gustavo", "Fernanda", "Rodrigo", "Daniela", "Bruno",
] as const;

export const LAST_NAMES = [
  "González", "Rodríguez", "Fernández", "López", "Martínez", "García", "Pérez", "Sánchez", "Romero", "Sosa",
  "Álvarez", "Torres", "Ruiz", "Ramírez", "Flores", "Acosta", "Benítez", "Medina", "Suárez", "Herrera",
  "Aguirre", "Pereyra", "Gutiérrez", "Giménez", "Molina", "Silva", "Castro", "Rojas", "Ortiz", "Núñez",
  "Luna", "Juárez", "Cabrera", "Ríos", "Ferreyra", "Godoy", "Morales", "Domínguez", "Moreno", "Peralta",
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Anderson", "Taylor",
  "Thomas", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark", "Lewis",
  "Walker", "Hall", "Allen", "Young", "King", "Wright", "Scott", "Green", "Baker", "Adams",
  "Nakamura", "Tanaka", "Chen", "Wang", "Kim", "Park", "Patel", "Sharma", "Singh", "Khan",
  "Haddad", "Nasser", "Larsen", "Nielsen", "Johansson", "Lindqvist", "Rossi", "Bianchi", "Ricci", "Moretti",
  "Dubois", "Lefebvre", "Moreau", "Laurent", "Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Wagner",
  "Costa", "Oliveira", "Souza", "Santos", "Lima", "Carvalho", "Almeida", "Ribeiro", "Barbosa", "Mendes",
] as const;

export const EXTERNAL_MANAGERS = [
  "Regional Director (contractor agency)",
  "Board liaison — Finance",
  "Outsourced Facilities Lead",
] as const;

export interface ModelSeed {
  category: string;
  manufacturer: string;
  name: string;
  specs: Record<string, string | number | boolean>;
}

export const ASSET_CATEGORY_SEEDS = [
  { name: "Monitor", description: "External displays", icon: "ComputerDesktopIcon" },
  { name: "Tablet", description: "Tablets and e-readers", icon: "DeviceTabletIcon" },
  { name: "Access Point", description: "Wireless access points", icon: "WifiIcon" },
  { name: "VoIP Phone", description: "Desk phones and conference units", icon: "PhoneIcon" },
  { name: "Docking Station", description: "USB-C and Thunderbolt docks", icon: "Square3Stack3DIcon" },
  { name: "Conference Room Kit", description: "Room cameras, speakerphones and displays", icon: "VideoCameraIcon" },
] as const;

export const ASSET_CATEGORY_RENAMES: readonly [string, string][] = [["Peripheral", "Peripherals & Accessories"]];
export const APPLICATION_CATEGORY_RENAMES: readonly [string, string][] = [["Third Party", "Third-party Vendors"]];
export const CONSUMABLE_CATEGORY_RENAMES: readonly [string, string][] = [["Office supplies", "Office & Desk Supplies"]];

export const APPLICATION_CATEGORY_SEEDS = [
  { name: "Collaboration", description: "Chat, video and shared documents" },
  { name: "Security", description: "Identity, endpoint and network security" },
  { name: "Engineering", description: "Source control, CI and observability" },
  { name: "Finance & HR", description: "Payroll, expenses and the people directory" },
] as const;

export const CONSUMABLE_CATEGORY_SEEDS = [
  { name: "Toner & Ink", description: "Printer cartridges and drums" },
  { name: "Storage Media", description: "USB drives, SD cards and spare disks" },
  { name: "Networking", description: "Patch cords, SFPs and keystones" },
] as const;

export const LAPTOP_SPECS_SCHEMA = [
  { key: "cpu", label: "CPU", type: "string", required: true },
  { key: "ramGb", label: "RAM (GB)", type: "number", required: true },
  { key: "storageGb", label: "Storage (GB)", type: "number" },
  { key: "os", label: "Operating system", type: "enum", enumValues: ["macOS", "Windows 11", "Ubuntu 24.04"] },
  { key: "encrypted", label: "Disk encrypted", type: "boolean" },
] as const;

export const MODELS: readonly ModelSeed[] = [
  { category: "Laptop", manufacturer: "Apple", name: "MacBook Pro 14 (M3 Pro)", specs: { cpu: "Apple M3 Pro", ramGb: 18, storageGb: 512, os: "macOS" } },
  { category: "Laptop", manufacturer: "Apple", name: "MacBook Pro 16 (M3 Max)", specs: { cpu: "Apple M3 Max", ramGb: 36, storageGb: 1024, os: "macOS" } },
  { category: "Laptop", manufacturer: "Apple", name: "MacBook Air 13 (M2)", specs: { cpu: "Apple M2", ramGb: 16, storageGb: 256, os: "macOS" } },
  { category: "Laptop", manufacturer: "Apple", name: "MacBook Air 15 (M3)", specs: { cpu: "Apple M3", ramGb: 16, storageGb: 512, os: "macOS" } },
  { category: "Laptop", manufacturer: "Dell", name: "Latitude 7440", specs: { cpu: "Intel Core i7-1365U", ramGb: 16, storageGb: 512, os: "Windows 11" } },
  { category: "Laptop", manufacturer: "Dell", name: "Latitude 5540", specs: { cpu: "Intel Core i5-1345U", ramGb: 16, storageGb: 256, os: "Windows 11" } },
  { category: "Laptop", manufacturer: "Dell", name: "XPS 13 9340", specs: { cpu: "Intel Core Ultra 7 155H", ramGb: 32, storageGb: 1024, os: "Windows 11" } },
  { category: "Laptop", manufacturer: "Lenovo", name: "ThinkPad X1 Carbon Gen 12", specs: { cpu: "Intel Core Ultra 7 165U", ramGb: 32, storageGb: 1024, os: "Windows 11" } },
  { category: "Laptop", manufacturer: "Lenovo", name: "ThinkPad T14 Gen 4", specs: { cpu: "AMD Ryzen 7 PRO 7840U", ramGb: 32, storageGb: 512, os: "Ubuntu 24.04" } },
  { category: "Laptop", manufacturer: "HP", name: "EliteBook 840 G10", specs: { cpu: "Intel Core i7-1355U", ramGb: 16, storageGb: 512, os: "Windows 11" } },
  { category: "Laptop", manufacturer: "Framework", name: "Laptop 13 (AMD)", specs: { cpu: "AMD Ryzen 7 7840U", ramGb: 32, storageGb: 1024, os: "Ubuntu 24.04" } },
  { category: "Desktop", manufacturer: "Dell", name: "OptiPlex 7010 Micro", specs: { cpu: "Intel Core i5-13500T", ramGb: 16, storageGb: 512 } },
  { category: "Desktop", manufacturer: "Apple", name: "Mac mini (M2)", specs: { cpu: "Apple M2", ramGb: 16, storageGb: 512 } },
  { category: "Desktop", manufacturer: "Lenovo", name: "ThinkCentre M90q Gen 4", specs: { cpu: "Intel Core i7-13700T", ramGb: 32, storageGb: 1024 } },
  { category: "Desktop", manufacturer: "HP", name: "Z2 Mini G9 Workstation", specs: { cpu: "Intel Core i9-13900", ramGb: 64, storageGb: 2048, gpu: "NVIDIA RTX A2000" } },
  { category: "Monitor", manufacturer: "Dell", name: "UltraSharp U2723QE", specs: { sizeInches: 27, resolution: "3840x2160", usbC: true } },
  { category: "Monitor", manufacturer: "Dell", name: "P2423D", specs: { sizeInches: 24, resolution: "2560x1440", usbC: false } },
  { category: "Monitor", manufacturer: "LG", name: "34WN80C-B UltraWide", specs: { sizeInches: 34, resolution: "3440x1440", usbC: true } },
  { category: "Monitor", manufacturer: "Apple", name: "Studio Display", specs: { sizeInches: 27, resolution: "5120x2880", usbC: true } },
  { category: "Monitor", manufacturer: "Samsung", name: "ViewFinity S8", specs: { sizeInches: 32, resolution: "3840x2160", usbC: true } },
  { category: "Mobile", manufacturer: "Apple", name: "iPhone 15", specs: { storageGb: 128, carrier: "Unlocked", esim: true } },
  { category: "Mobile", manufacturer: "Apple", name: "iPhone 15 Pro", specs: { storageGb: 256, carrier: "Unlocked", esim: true } },
  { category: "Mobile", manufacturer: "Samsung", name: "Galaxy S24", specs: { storageGb: 256, carrier: "Unlocked", esim: true } },
  { category: "Mobile", manufacturer: "Google", name: "Pixel 8", specs: { storageGb: 128, carrier: "Unlocked", esim: true } },
  { category: "Tablet", manufacturer: "Apple", name: "iPad Air 11 (M2)", specs: { storageGb: 128, cellular: false } },
  { category: "Tablet", manufacturer: "Samsung", name: "Galaxy Tab S9", specs: { storageGb: 256, cellular: true } },
  { category: "Docking Station", manufacturer: "Dell", name: "WD22TB4 Thunderbolt Dock", specs: { ports: 11, powerW: 130 } },
  { category: "Docking Station", manufacturer: "CalDigit", name: "TS4", specs: { ports: 18, powerW: 98 } },
  { category: "Peripheral", manufacturer: "Logitech", name: "MX Keys S Combo", specs: { connection: "Bluetooth", layout: "US International" } },
  { category: "Peripheral", manufacturer: "Jabra", name: "Evolve2 65", specs: { connection: "USB-A dongle", anc: true } },
  { category: "Peripheral", manufacturer: "Logitech", name: "Brio 4K Webcam", specs: { resolution: "4K", connection: "USB-C" } },
  { category: "Printer", manufacturer: "HP", name: "LaserJet Enterprise M611dn", specs: { color: false, duplex: true, ppm: 65 } },
  { category: "Printer", manufacturer: "Brother", name: "MFC-L8900CDW", specs: { color: true, duplex: true, ppm: 33 } },
  { category: "Server", manufacturer: "Dell", name: "PowerEdge R650", specs: { cpu: "2x Intel Xeon Gold 6338", ramGb: 256, rackUnits: 1 } },
  { category: "Server", manufacturer: "Dell", name: "PowerEdge R750", specs: { cpu: "2x Intel Xeon Gold 6354", ramGb: 512, rackUnits: 2 } },
  { category: "Server", manufacturer: "HPE", name: "ProLiant DL380 Gen11", specs: { cpu: "2x Intel Xeon Silver 4410Y", ramGb: 256, rackUnits: 2 } },
  { category: "Server", manufacturer: "Supermicro", name: "SYS-1029P-WTR", specs: { cpu: "2x Intel Xeon Silver 4214", ramGb: 128, rackUnits: 1 } },
  { category: "Switch", manufacturer: "Cisco", name: "Catalyst 9300-48P", specs: { ports: 48, poe: true, uplinks: "4x 10G" } },
  { category: "Switch", manufacturer: "Aruba", name: "CX 6200F 24G", specs: { ports: 24, poe: true, uplinks: "4x 10G" } },
  { category: "Switch", manufacturer: "Ubiquiti", name: "USW-Pro-48-PoE", specs: { ports: 48, poe: true, uplinks: "4x 10G" } },
  { category: "Router", manufacturer: "Cisco", name: "ISR 1111-8P", specs: { wanPorts: 2, throughputMbps: 1000 } },
  { category: "Router", manufacturer: "MikroTik", name: "CCR2004-16G-2S+", specs: { wanPorts: 2, throughputMbps: 10000 } },
  { category: "Firewall", manufacturer: "Fortinet", name: "FortiGate 100F", specs: { throughputGbps: 20, haPair: true } },
  { category: "Firewall", manufacturer: "Palo Alto Networks", name: "PA-440", specs: { throughputGbps: 2.4, haPair: false } },
  { category: "Firewall", manufacturer: "Netgate", name: "pfSense 6100", specs: { throughputGbps: 18, haPair: true } },
  { category: "Storage", manufacturer: "Synology", name: "RackStation RS3621xs+", specs: { bays: 12, rawTb: 144, raid: "RAID 6" } },
  { category: "Storage", manufacturer: "NetApp", name: "AFF A250", specs: { bays: 24, rawTb: 92, raid: "RAID-DP" } },
  { category: "UPS", manufacturer: "APC", name: "Smart-UPS SRT 3000VA", specs: { va: 3000, rackUnits: 2, runtimeMin: 12 } },
  { category: "UPS", manufacturer: "Eaton", name: "9PX 6kVA", specs: { va: 6000, rackUnits: 3, runtimeMin: 9 } },
  { category: "Access Point", manufacturer: "Ubiquiti", name: "U6 Enterprise", specs: { wifi: "6E", poe: "802.3at" } },
  { category: "Access Point", manufacturer: "Aruba", name: "AP-635", specs: { wifi: "6E", poe: "802.3at" } },
  { category: "Access Point", manufacturer: "Cisco", name: "Meraki MR46", specs: { wifi: "6", poe: "802.3at" } },
  { category: "VoIP Phone", manufacturer: "Poly", name: "VVX 450", specs: { lines: 12, poe: true } },
  { category: "VoIP Phone", manufacturer: "Yealink", name: "T54W", specs: { lines: 16, poe: true } },
  { category: "Conference Room Kit", manufacturer: "Logitech", name: "Rally Bar", specs: { camera: "4K PTZ", platform: "Zoom Rooms" } },
  { category: "Conference Room Kit", manufacturer: "Poly", name: "Studio X50", specs: { camera: "4K", platform: "Microsoft Teams Rooms" } },
  { category: "Other", manufacturer: "Raspberry Pi", name: "Raspberry Pi 5 (8GB)", specs: { ramGb: 8, purpose: "Signage / kiosk" } },
  { category: "Other", manufacturer: "Zebra", name: "ZD421 Label Printer", specs: { dpi: 300, connection: "USB / Ethernet" } },
  { category: "Laptop", manufacturer: "Dell", name: "Latitude 5490 (legacy)", specs: { cpu: "Intel Core i5-8350U", ramGb: 8, storageGb: 256, os: "Windows 11" } },
  { category: "Desktop", manufacturer: "HP", name: "ProDesk 600 G3 (legacy)", specs: { cpu: "Intel Core i5-7500", ramGb: 8, storageGb: 256 } },
];

// The last two models are retired from the catalog: archived and never used by new assets.
export const ARCHIVED_MODEL_COUNT = 2;

export const STATUS_LABELS = [
  { name: "Deployed", kind: "OPERATIONAL", color: "#16A34A", description: "In use by its owner" },
  { name: "Awaiting parts", kind: "IN_MAINTENANCE", color: "#F59E0B", description: "Repair blocked on a part order" },
  { name: "Ready to deploy", kind: "IN_STORAGE", color: "#6366F1", description: "Imaged and waiting for a new hire" },
  { name: "E-waste pending", kind: "RETIRED", color: "#64748B", description: "Waiting for the certified recycler pickup" },
  { name: "Reported stolen", kind: "LOST", color: "#DC2626", description: "Police report filed" },
  { name: "Audit pending", kind: "UNKNOWN", color: "#A16207", description: "Not seen in the last inventory count" },
  { name: "Loaner pool", kind: "OPERATIONAL", color: "#0EA5E9", description: "Lent out short term from the IT desk" },
  { name: "At vendor repair", kind: "IN_MAINTENANCE", color: "#D97706", description: "Shipped to the manufacturer or a repair shop" },
  { name: "Pending wipe", kind: "IN_STORAGE", color: "#8B5CF6", description: "Returned, data not yet erased" },
  { name: "Donated", kind: "RETIRED", color: "#94A3B8", description: "Given to a school or NGO after wipe" },
  { name: "Hot spare", kind: "OPERATIONAL", color: "#14B8A6", description: "Powered on and ready to swap in" },
] as const;

export const SUPPLIERS = [
  "Compumundo", "Datacenter Supplies SRL", "TechSource Global", "Northwind IT Distribution", "Bluewave Networks",
  "Channel Direct Wholesale", "Insight Partners Supply", "Mercado Corporativo", "Iberia Tech Distribución", "Lone Star Hardware",
  "Cable & Connectors Inc.", "PrintPro Services", "SecureLine Telecom", "CloudSeat Licensing", "Rack & Power Solutions",
  "Pampa Informática", "Atlas Office Supply", "Vertex Systems", "Andes Electronics", "Orbit Repair Center",
  "GreenCycle E-Waste", "Summit Software Licensing", "Harbor Logistics", "Nimbus Data Storage", "Quantum Peripherals",
  "Patagonia Networks", "Meridian Office Furniture", "Keystone Security Systems",
] as const;

export const ARCHIVED_SUPPLIERS = ["Orbit Repair Center", "Lone Star Hardware"] as const;

export interface AppSeed {
  name: string;
  vendor: string;
  url: string;
  category: string;
  critical: boolean;
  seats: number;
  costPerSeatCents: number;
  levels: readonly string[];
  description: string;
}

export const APPLICATIONS: readonly AppSeed[] = [
  { name: "Google Workspace", vendor: "Google", url: "https://workspace.google.com", category: "Collaboration", critical: false, seats: 4200, costPerSeatCents: 1200, levels: ["User", "Groups Admin", "Admin"], description: "Mail, calendar and shared drives" },
  { name: "Slack", vendor: "Salesforce", url: "https://slack.com", category: "Collaboration", critical: false, seats: 4000, costPerSeatCents: 875, levels: ["Member", "Workspace Admin", "Guest"], description: "Company chat" },
  { name: "Zoom", vendor: "Zoom Video Communications", url: "https://zoom.us", category: "Collaboration", critical: false, seats: 900, costPerSeatCents: 1332, levels: ["Basic", "Licensed", "Admin"], description: "Video meetings and rooms" },
  { name: "Okta", vendor: "Okta", url: "https://acme-demo.okta.com", category: "Security", critical: true, seats: 4200, costPerSeatCents: 600, levels: ["User", "Help Desk Admin", "Super Admin"], description: "Single sign-on and MFA" },
  { name: "CrowdStrike Falcon", vendor: "CrowdStrike", url: "https://falcon.crowdstrike.com", category: "Security", critical: true, seats: 4500, costPerSeatCents: 899, levels: ["Analyst", "Responder", "Administrator"], description: "Endpoint detection and response" },
  { name: "GitHub Enterprise", vendor: "GitHub", url: "https://github.com/acme-demo", category: "Engineering", critical: false, seats: 600, costPerSeatCents: 2100, levels: ["Read", "Write", "Maintain", "Admin"], description: "Source control" },
  { name: "Jira Software", vendor: "Atlassian", url: "https://acme-demo.atlassian.net", category: "Engineering", critical: false, seats: 1500, costPerSeatCents: 815, levels: ["Viewer", "User", "Project Admin"], description: "Issue tracking" },
  { name: "Confluence", vendor: "Atlassian", url: "https://acme-demo.atlassian.net/wiki", category: "Collaboration", critical: false, seats: 1500, costPerSeatCents: 605, levels: ["Viewer", "Editor", "Space Admin"], description: "Team wiki" },
  { name: "Datadog", vendor: "Datadog", url: "https://app.datadoghq.com", category: "Engineering", critical: false, seats: 150, costPerSeatCents: 2300, levels: ["Read Only", "Standard", "Admin"], description: "Monitoring and APM" },
  { name: "AWS Production", vendor: "Amazon Web Services", url: "https://acme-demo.awsapps.com/start", category: "Infrastructure", critical: true, seats: 120, costPerSeatCents: 0, levels: ["ReadOnly", "PowerUser", "Administrator"], description: "Production cloud accounts" },
  { name: "Corporate VPN", vendor: "Fortinet", url: "vpn.acme-demo.test", category: "Infrastructure", critical: false, seats: 2500, costPerSeatCents: 150, levels: ["Standard", "Split tunnel", "Full tunnel"], description: "Remote access to the office networks" },
  { name: "Workday", vendor: "Workday", url: "https://www.myworkday.com/acme-demo", category: "Finance & HR", critical: false, seats: 4200, costPerSeatCents: 950, levels: ["Employee", "Manager", "HR Partner"], description: "HR and payroll" },
  { name: "NetSuite", vendor: "Oracle", url: "https://acme-demo.app.netsuite.com", category: "Finance & HR", critical: false, seats: 80, costPerSeatCents: 9900, levels: ["Viewer", "Accountant", "Administrator"], description: "ERP and accounting" },
  { name: "Figma", vendor: "Figma", url: "https://www.figma.com", category: "SaaS", critical: false, seats: 120, costPerSeatCents: 4500, levels: ["Viewer", "Editor", "Admin"], description: "Design and prototyping" },
  { name: "1Password Business", vendor: "AgileBits", url: "https://acme-demo.1password.com", category: "Security", critical: false, seats: 700, costPerSeatCents: 799, levels: ["Member", "Vault Manager", "Owner"], description: "Shared vaults for team credentials" },
  { name: "Salesforce", vendor: "Salesforce", url: "https://acme-demo.my.salesforce.com", category: "SaaS", critical: false, seats: 350, costPerSeatCents: 16500, levels: ["Read Only", "Standard User", "System Administrator"], description: "CRM for the sales team" },
  { name: "Internal Billing Portal", vendor: "Acme Engineering", url: "https://billing.acme-demo.test", category: "Internal", critical: false, seats: 0, costPerSeatCents: 0, levels: ["Read", "Operator", "Admin"], description: "In-house invoicing tool" },
];

export const CONSUMABLES = [
  { name: "USB-C to USB-C cable 2m", sku: "CBL-USBC-2M", category: "Cables", unit: "units", minStock: 40 },
  { name: "HDMI 2.1 cable 3m", sku: "CBL-HDMI-3M", category: "Cables", unit: "units", minStock: 25 },
  { name: "DisplayPort 1.4 cable 2m", sku: "CBL-DP-2M", category: "Cables", unit: "units", minStock: 15 },
  { name: "Cat6 patch cord 1m (blue)", sku: "NET-CAT6-1M", category: "Networking", unit: "units", minStock: 100 },
  { name: "Cat6 patch cord 3m (grey)", sku: "NET-CAT6-3M", category: "Networking", unit: "units", minStock: 60 },
  { name: "SFP+ 10GBASE-SR transceiver", sku: "NET-SFP-SR", category: "Networking", unit: "units", minStock: 8 },
  { name: "Cat6 keystone jack", sku: "NET-KEYSTONE", category: "Networking", unit: "units", minStock: 50 },
  { name: "USB-C to HDMI adapter", sku: "ADP-USBC-HDMI", category: "Adapters", unit: "units", minStock: 20 },
  { name: "USB-C to Ethernet adapter", sku: "ADP-USBC-ETH", category: "Adapters", unit: "units", minStock: 15 },
  { name: "Lightning to 3.5mm adapter", sku: "ADP-LTG-35", category: "Adapters", unit: "units", minStock: 5 },
  { name: "Travel power adapter (universal)", sku: "ADP-TRAVEL", category: "Adapters", unit: "units", minStock: 10 },
  { name: "Wireless mouse", sku: "PER-MOUSE-WL", category: "Peripherals", unit: "units", minStock: 30 },
  { name: "Wired keyboard (US Intl)", sku: "PER-KB-USI", category: "Peripherals", unit: "units", minStock: 20 },
  { name: "Wired keyboard (ES)", sku: "PER-KB-ES", category: "Peripherals", unit: "units", minStock: 10 },
  { name: "USB headset with mic", sku: "PER-HEADSET", category: "Peripherals", unit: "units", minStock: 25, returnable: true },
  { name: "Laptop stand (aluminium)", sku: "PER-STAND", category: "Peripherals", unit: "units", minStock: 10 },
  { name: "Loaner USB-C charger 65W", sku: "PER-CHG-65W", category: "Peripherals", unit: "units", minStock: 8, returnable: true },
  { name: "Privacy screen 14\"", sku: "PER-PRIV-14", category: "Peripherals", unit: "units", minStock: 6 },
  { name: "HP 147A toner (black)", sku: "TNR-HP147A", category: "Toner & Ink", unit: "cartridges", minStock: 6 },
  { name: "Brother TN-436 toner (cyan)", sku: "TNR-TN436C", category: "Toner & Ink", unit: "cartridges", minStock: 3 },
  { name: "Brother TN-436 toner (magenta)", sku: "TNR-TN436M", category: "Toner & Ink", unit: "cartridges", minStock: 3 },
  { name: "Brother TN-436 toner (yellow)", sku: "TNR-TN436Y", category: "Toner & Ink", unit: "cartridges", minStock: 3 },
  { name: "Brother TN-436 toner (black)", sku: "TNR-TN436K", category: "Toner & Ink", unit: "cartridges", minStock: 4 },
  { name: "Zebra label roll 4x6", sku: "TNR-ZEBRA-46", category: "Toner & Ink", unit: "rolls", minStock: 12 },
  { name: "USB flash drive 64GB (encrypted)", sku: "MED-USB-64", category: "Storage Media", unit: "units", minStock: 10 },
  { name: "microSD 128GB", sku: "MED-SD-128", category: "Storage Media", unit: "units", minStock: 10 },
  { name: "Spare SSD 1TB NVMe", sku: "MED-NVME-1T", category: "Storage Media", unit: "units", minStock: 4 },
  { name: "Spare HDD 12TB SAS", sku: "MED-HDD-12T", category: "Storage Media", unit: "units", minStock: 2 },
  { name: "LTO-9 tape cartridge", sku: "MED-LTO9", category: "Storage Media", unit: "units", minStock: 10 },
  { name: "AA batteries", sku: "OFF-BAT-AA", category: "Office supplies", unit: "packs", minStock: 20 },
  { name: "AAA batteries", sku: "OFF-BAT-AAA", category: "Office supplies", unit: "packs", minStock: 20 },
  { name: "Asset tag stickers", sku: "OFF-TAGS", category: "Office supplies", unit: "sheets", minStock: 30 },
  { name: "Cable ties (100 pack)", sku: "OFF-TIES", category: "Office supplies", unit: "packs", minStock: 10 },
  { name: "Whiteboard markers", sku: "OFF-MARKERS", category: "Office supplies", unit: "packs", minStock: 15 },
  { name: "Screen cleaning kit", sku: "OFF-CLEAN", category: "Office supplies", unit: "units", minStock: 10 },
  { name: "Velcro cable straps", sku: "OFF-VELCRO", category: "Other", unit: "rolls", minStock: 5 },
  { name: "Thermal paste syringe", sku: "OTH-THERMAL", category: "Other", unit: "units", minStock: 3 },
  { name: "Anti-static wrist strap", sku: "OTH-ESD", category: "Other", unit: "units", minStock: 4 },
  { name: "Rack screws M6 (50 pack)", sku: "OTH-M6", category: "Other", unit: "packs", minStock: 5 },
  { name: "Blank keycard (MIFARE)", sku: "OTH-KEYCARD", category: "Other", unit: "units", minStock: 50 },
  { name: "USB-C to Lightning cable 1m", sku: "CBL-USBC-LTG", category: "Cables", unit: "units", minStock: 15 },
  { name: "Power cord C13 1.8m", sku: "CBL-C13", category: "Cables", unit: "units", minStock: 30 },
  { name: "Fiber patch cord LC-LC 3m", sku: "NET-LCLC-3M", category: "Networking", unit: "units", minStock: 12 },
  { name: "Webcam privacy cover", sku: "PER-CAMCOVER", category: "Peripherals", unit: "units", minStock: 25 },
  { name: "Docking station power brick", sku: "ADP-DOCK-PSU", category: "Adapters", unit: "units", minStock: 4 },
  { name: "Label tape 12mm", sku: "OFF-LABEL-12", category: "Office supplies", unit: "rolls", minStock: 8 },
] as const;

export const ARCHIVED_CONSUMABLE_SKU = "ADP-LTG-35";

export const GRANT_NOTES = [
  "Requested by manager during onboarding",
  "Access review Q3 — confirmed still needed",
  "Temporary access for the migration project",
  "Contractor engagement, see SOW",
  "Break-glass access, review monthly",
] as const;

export const REVOKE_NOTES = [
  "Role change — no longer needed",
  "Access review: unused for 90 days",
  "Project finished",
  "License reclaimed",
] as const;

export const JUSTIFICATIONS = [
  "Joining the project team next sprint",
  "Need to review the quarterly reports",
  "Covering for a teammate on leave",
  "Required for the on-call rotation",
  "New responsibilities after the reorg",
  "Customer escalation needs read access",
] as const;

export const DENY_REASONS = [
  "Not required for your role; ask your manager to sponsor it",
  "License pool is exhausted until renewal",
  "Use the shared read-only report instead",
  "Request a narrower access level",
  "Pending security training completion",
] as const;
