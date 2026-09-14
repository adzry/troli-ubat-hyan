
# Troli Ubat HYAN — Enterprise Medication Trolley Logistics & SLA Framework

Production-grade real-time workflow tracking, operational telemetry, and compliance monitoring system for clinical wards and the Central Pharmacy at **Hospital Yan**.

---

## Architecture & Monorepo Structure

The system operates on a decentralized Google Apps Script (GAS) architecture sharing a centralized Google Sheets persistence layer.

```text
/troli-ubat-hyan (Monorepo Root)
├── README.md
├── .gitignore
├── /sistem-notifikasi/        # Ward UI & Real-Time Event Notifier
│   ├── Code.gs                # Core event listener, form triggers, SLA logic
│   ├── Index.html             # Tailwind / Legions UI frontend with polling logic
│   ├── Editformscript.gs      # Form automation helpers
│   ├── Fixjawatanlabel.gs     # Role normalization pipeline
│   └── appsscript.json        # GAS Manifest (Timezone: Asia/Kuala_Lumpur)
└── /dashboard-analitik/       # Analytics Reporting & Telemetry Frontend
    ├── Code.gs                # Read-only aggregation engine (Log_Troli & SLA_Summary)
    ├── Index.html             # Executive command center dashboard UI
    └── appsscript.json        # GAS Manifest (Read-only isolation layer)

Technical Specifications & Configuration
1. Sistem Notifikasi (/sistem-notifikasi)
Script ID: 1wQuVAlL19QYNLOuQ2cLalRvV9t7jq5WbKqvn06faSuMzVAXWnh2zSeyj

Purpose: Deployed per-ward UI (e.g., Wad Lelaki 4B) handling status updates, live 10-second polling, and audio-visual alarms.

Lifecycle Events:

Hantar Troli (Dispatches cart to Pharmacy — Starts SLA clock).

Pengisian ubat selesai (Pharmacy marks refill complete — Triggers ward alert).

Troli ubat/pesanan ubat telah diambil (Ward retrieves cart — Closes cycle).

2. Dashboard Analitik (/dashboard-analitik)
Script ID: 1y6e1alYTrHSyD4oe44yxk3JWS--0YHg0bTamFE-defP6ihvOlsxRF_FP

Purpose: Read-only executive command center monitoring multi-ward compliance across 13 clinical units.

3. Database & External Bindings
Shared Database Sheet ID: 1XkTASMH6_M02iRmi0dZZlg2NddJjVkNTYREPukaMwno (Log_Troli & SLA_Summary)

Floor Stock Reference ID: 1nlr3XeAtLvlGyz9KyAj5dRWxcVqGyqkT0rUdVDX6BlI

SLA Threshold: 4 Hours (4 * 60 * 60 * 1000 ms)

Covered Units (13 Total):

Wards: Wad Lelaki 4A, Wad Lelaki 4B, Wad Perempuan, Wad Bersalin, Wad Kanak-Kanak, Unit Hemodialisis, Wad Test

Other Units: Kecemasan & Trauma, Klinik Sejahtera, Klinik Pakar, ESWL, Forensik, Patologi, Fisioterapi, Unit Cara Kerja (Occupational Therapy)

Show quoted text
