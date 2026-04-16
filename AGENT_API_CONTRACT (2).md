# TenderFlow Agent API Contract

This document defines exactly how the Tender Hunter agent should send discovered tenders to TenderFlow. TenderFlow owns all validation, deduplication, and insertion logic. The agent's job is simple: **scrape, map, and POST**.

---

## Endpoint

```
POST {TENDERFLOW_BASE_URL}/api/agent/ingest-tenders
```

Production URL : `https://tenderflow.vercel.app/api/agent/ingest-tenders`



---

## Authentication

```
Authorization: Bearer ed21e4dc38c373fe79e1a76b7a093cb4be2a77e90bc895620c02ae1e66eb90d5
User ID: d223f639-0aca-47b6-abc4-68658f858729

Content-Type: application/json
```

- The API key will be provided by the TenderFlow owner
- Do NOT use Supabase keys — the agent never talks to Supabase directly
- If you get `401`, the key is wrong or missing

---

## Request Body

Send a batch of tenders (1–50 per request):

```json
{
  "tenders": [
    {
      "tender_name": "Supply of Laboratory Equipment for AAU",
      "publishing_entity": "Addis Ababa University",
      "tender_number": "AAU/NCB/2026/045",
      "deadline": "2026-04-20T10:00:00",
      "source_link": "https://tender.2merkato.com/tenders/123456",
      "source_portal": "2merkato",
      "category": "Lab & Chemicals",
      "tender_type": "local",
      "bid_type": "Open",
      "currency": "ETB",
      "notes": "Requires ISO 17025 certification. Lot-based bidding."
    }
  ]
}
```

### Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `tender_name` | string | **Yes** | Full tender title as shown on the portal |
| `publishing_entity` | string | **Yes** | The procuring entity / buyer name |
| `deadline` | string | **Yes** | ISO 8601 datetime. Must be in the future |
| `tender_number` | string | No | Reference number if available (e.g., "AAU/NCB/2026/045") |
| `source_link` | string | No | Direct URL to the tender listing. Strongly recommended |
| `source_portal` | string | No | One of: `2merkato`, `egp`, `reporter`, `globaltenders`, `web_search`, `other` |
| `category` | string | No | Must be one of the exact values below. Defaults to `General` |
| `tender_type` | string | No | `local` or `import`. Defaults to `local` |
| `bid_type` | string | No | One of: `Open`, `Limited`, `RFP`, `RFQ`, `Others`. Defaults to `Open` |
| `currency` | string | No | `ETB`, `USD`, `EUR`, `GBP`. Defaults to `ETB` |
| `notes` | string | No | Any extra info the agent extracted (requirements, lot numbers, etc.) |

### Exact Category Values

Use these **exactly** — any other value gets mapped to `General`:

```
Lab & Chemicals
Medical
Vet & Agri
Electronics & IT
Education & Stationery
Car & Auto
Cleaning & Janitorial
Food & Institutional
General
Other
```

### Category Mapping Guide

When the source portal uses different terms, map them like this:

| Portal Says | Send As |
|---|---|
| IT, ICT, Technology, Computers, Software | `Electronics & IT` |
| Medical, Health, Pharmaceutical, Hospital | `Medical` |
| Laboratory, Lab, Scientific, Chemicals, Reagents | `Lab & Chemicals` |
| Agriculture, Veterinary, Livestock, Seeds | `Vet & Agri` |
| Education, School, University, Books, Stationery | `Education & Stationery` |
| Vehicle, Car, Auto, Spare parts, Tyre | `Car & Auto` |
| Cleaning, Janitorial, Sanitation, Hygiene | `Cleaning & Janitorial` |
| Food, Catering, Kitchen, Institutional supply | `Food & Institutional` |
| Anything else / unclear | `General` |

### Import Detection

Set `tender_type: "import"` if the tender text contains keywords like:
- "international competitive bidding" / "ICB"
- "import", "foreign supplier", "international supplier"
- "letter of credit" / "LC"
- "CIF", "FOB", "freight"

Otherwise default to `"local"`.

---

## Response

### Success — tenders processed

```
HTTP 200
```

```json
{
  "created": 2,
  "skipped": 1,
  "errors": 0,
  "results": [
    {
      "tender_name": "Supply of Laboratory Equipment for AAU",
      "status": "created",
      "id": "a1b2c3d4-..."
    },
    {
      "tender_name": "Procurement of Desktop Computers",
      "status": "created",
      "id": "e5f6g7h8-..."
    },
    {
      "tender_name": "Supply of Reagents — Jimma University",
      "status": "skipped",
      "reason": "duplicate"
    }
  ]
}
```

### Error responses

| Code | Meaning | Example |
|---|---|---|
| `400` | Bad request — missing required fields or invalid data | `{ "error": "tenders[0]: deadline is required" }` |
| `401` | Unauthorized — bad or missing API key | `{ "error": "Invalid API key" }` |
| `429` | Rate limited — too many requests | `{ "error": "Rate limit exceeded. Max 200 tenders/day" }` |

---

## Deduplication

TenderFlow handles all dedup. You do NOT need to check for duplicates before sending.

The server computes a fingerprint from `lowercase(tender_name) + lowercase(publishing_entity) + deadline_date` and checks it against existing tenders. If a match is found, the tender is skipped (not an error).

If you send the same batch twice, you get the same result — the endpoint is fully idempotent.

You can drop your `seen_tenders.json` local cache if you want. It's fine to keep it as a performance optimization (avoid unnecessary API calls), but TenderFlow never relies on it.

---

## What TenderFlow Does on Its Side

When a tender arrives at the API, TenderFlow will:

1. Validate all required fields
2. Reject expired deadlines
3. Normalize category/bid_type/currency to known values
4. Compute a SHA-256 fingerprint for deduplication
5. Check fingerprint against existing tenders for this user
6. Insert with `source: 'agent'`, `status: 'Open'`, `decision: 'pending'`
7. Auto-compute `internal_deadline` as `deadline - 3 days`
8. Auto-initialize `phases_data` with Phase 1 Discovery marked as complete

The user sees agent-discovered tenders in their dashboard with a distinct badge. They review and decide to proceed or drop.

---

## Rate Limits

| Limit | Value |
|---|---|
| Max tenders per request | 50 |
| Max tenders per day | 200 |
| Max request body size | 100 KB |

---

## Example: Minimal Request

The smallest valid request:

```json
{
  "tenders": [
    {
      "tender_name": "Supply of Office Furniture",
      "publishing_entity": "Ministry of Education",
      "deadline": "2026-05-15T10:00:00"
    }
  ]
}
```

TenderFlow will fill in defaults: `status: Open`, `decision: pending`, `currency: ETB`, `bid_type: Open`, `tender_type: local`, `category: General`, `source: agent`.

---

## Example: Full Request

```json
{
  "tenders": [
    {
      "tender_name": "Supply and Installation of Network Equipment for 50 Woredas",
      "publishing_entity": "Ministry of Innovation and Technology",
      "tender_number": "MINT/ICB/2026/012",
      "deadline": "2026-05-20T14:30:00",
      "source_link": "https://egp.gov.et/tenders/detail/98765",
      "source_portal": "egp",
      "category": "Electronics & IT",
      "tender_type": "import",
      "bid_type": "Open",
      "currency": "USD",
      "notes": "International Competitive Bidding. Pre-qualification required. Lot 1: Routers, Lot 2: Switches, Lot 3: UPS Systems. Joint ventures permitted."
    },
    {
      "tender_name": "Procurement of Surgical Gloves and PPE",
      "publishing_entity": "St. Paul's Hospital Millennium Medical College",
      "tender_number": "SPHMMC/SH/2026/089",
      "deadline": "2026-04-28T10:00:00",
      "source_link": "https://tender.2merkato.com/tenders/456789",
      "source_portal": "2merkato",
      "category": "Medical",
      "tender_type": "local",
      "bid_type": "Open",
      "currency": "ETB",
      "notes": "Annual framework contract. Delivery within 30 days of PO."
    }
  ]
}
```

---

## Checklist for the Agent

- [ ] Use `Authorization: Bearer <key>` header (key will be provided)
- [ ] Send `Content-Type: application/json`
- [ ] Batch tenders into arrays of up to 50
- [ ] Use exact category values from the list above
- [ ] Send `deadline` as ISO 8601 (future dates only)
- [ ] Include `source_link` and `source_portal` when available
- [ ] Handle `200` response — check `results` array for created/skipped status
- [ ] Handle `401` — stop and report auth failure
- [ ] Handle `429` — back off and retry later
- [ ] Do NOT write to Supabase directly — all writes go through this API
