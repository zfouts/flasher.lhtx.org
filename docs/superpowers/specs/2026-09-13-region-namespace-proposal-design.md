# Region namespace proposal — design

**Date:** 2026-09-13
**Status:** approved for planning
**Deliverable:** `flasher.lhtx.org/regions/`, a page proposing a shared MeshCore
region namespace to North Texas Mesh, Austin Mesh, San Antonio Mesh and other
Texas mesh groups.

## Problem

Region names are a namespace shared across neighbouring meshes. They compile to
a fixed 2-byte hash over the air, so two groups that pick different names for
the same area do not interoperate, and two groups that pick the same name for
different areas collide. Nothing enforces agreement and no registry exists.

Liberty Hill already ships a hierarchy in `public/config.json` that reaches down
through `us-tx-central` to `us-tx-aus` — a name for the Austin metro, chosen by
someone who is not Austin Mesh. That is only defensible as a proposal, and only
if the proposal is written down and circulated.

The mesh-side problem the namespace solves is flood traffic: a message on a
local channel still reaches every distant repeater in range unless a region
scopes it. Regions are the only mechanism that bounds it. This is the reader's
existing pain and it is the page's opening argument.

## Goals

- A reader from another group leaves with the exact `region put` lines for
  their own repeaters, ready to paste.
- The nesting mechanic is understood: a parent cascades down to its children,
  and traffic on a child does not climb.
- The ask is legitimate. We are naming other people's areas, and the page has
  to say plainly that we do not own the namespace and will change our names to
  match theirs if they pick differently.

## Non-goals

- No registry, no claiming workflow, no accounts. The page is a document.
- No change to what Liberty Hill writes to its own radios.
- No coverage outside Texas, and no general derivation rule for other states.
  The naming rules are stated to justify the Texas names, not as a scheme for
  everywhere else.

## The namespace

Three levels of basis, deliberately: the trunk is census geography so it is
not ours to argue about, the area level is conventional Texas usage, and the
metro level is the IATA code of the primary airport so it is short, unique,
and not a matter of taste.

```
us                                       country
└─ us-south                              Census region: South
   └─ us-southcentral                    Census division: West South Central
      └─ us-tx                           state
         ├─ us-tx-central
         │  └─ us-tx-aus                 Austin Mesh
         ├─ us-tx-south
         │  └─ us-tx-sat                 San Antonio Mesh
         └─ us-tx-north
            └─ us-tx-dfw                 North Texas Mesh

lhtx                                     Liberty Hill Mesh — standalone
```

**Local names are standalone and not nested.** `lhtx` is the worked example.
Carrying a region is not the same as nesting under it: a Liberty Hill repeater
runs the whole trunk plus `us-tx-aus` plus `lhtx`, so it receives cascades from
every level above while keeping its own local traffic to itself. Each group
picks its own local name; we propose nothing there.

### Naming rules the page states

| Level | Form | Basis |
| --- | --- | --- |
| Country | `us` | fixed |
| Census region | `us-<region>` | US Census |
| Census division | `us-<division>` | US Census |
| State | `us-<state>` | USPS code |
| Area | `us-<state>-<area>` | conventional usage |
| Metro | `us-<state>-<iata>` | primary airport IATA code |
| Local | short, standalone | the group's own choice |

### Groups named

Only groups known to exist get a name. Unassigned areas are shown as open
rather than pre-claimed, so nobody has to come to us to be added; they follow
the rule.

## Architecture

**A new data file, separate from `config.json`.** `public/regions-proposal.json`
holds the proposed namespace and which group holds each name.
`config.json.regions` is untouched and keeps its current meaning: the regions
this tool writes to Liberty Hill radios.

The separation is the point. `validateRegions()` and `planRepeater()` consume
`config.json.regions` to decide what gets written. If the proposal lived there,
the only thing stopping a Liberty Hill repeater from being handed `us-tx-dfw`
would be a filter someone has to remember to keep correct.

**The page is generated, not hand-written.** `scripts/sync-regions.mjs` renders
`public/regions/index.html` from the proposal file, following the existing
`sync-readme.mjs` pattern exactly: a `--check` mode, and a test that fails when
the output is stale. The repo's stated discipline is that the on-screen summary
is derived so that what the page claims and what it sends are the same; a
hand-written page of commands would be precisely the drift that rule exists to
prevent.

**Commands come from `regionPutLine()`**, imported from
`public/js/repeater.js` — the same function `planRepeater()` uses. The page
cannot print a line the tool would not send.

### Files

| File | Change |
| --- | --- |
| `public/regions-proposal.json` | new — namespace, group ownership, convention |
| `scripts/sync-regions.mjs` | new — renders the page; `--check` for staleness |
| `public/regions/index.html` | new, generated — do not edit by hand |
| `public/css/regions.css` | new — external, required by CSP |
| `test/regions-proposal.test.mjs` | new — see Testing |
| `package.json` | `docs` script also runs `sync-regions.mjs` |
| `public/_headers` | cache rule for `/regions/` matching `/index.html` |

## Page structure

1. **The flood problem.** Opens on the reader's pain, not our idea. A local
   message reaching every repeater in range is the thing regions fix.
2. **What a region is and is not.** Not a channel, not a radio setting.
   Channels decide who can decrypt; regions decide how far a repeater
   forwards. 2-byte hash, so a long name costs nothing.
3. **How nesting behaves.** Parent cascades down, child stays local. The one
   mechanic that must land; gets a diagram.
4. **The proposed map.** The tree, plus a table of name, basis, and holder.
5. **Your commands.** Per group, copy-paste, generated by `regionPutLine()`.
6. **What we are not claiming.** No ownership, no registry. If a group wants a
   different name for its own area, we change ours. Includes the honest
   limitation below.

### Honesty constraint

The CLI surface this tool uses is `region put`, `region list allowed` and
`region save`. There is no removal command among them. The page must not
describe adoption as reversible or trivially undone; it may say the names are
cheap over the air, which is true, but not that they are easy to take back.
If a removal command exists in firmware, that is to be verified before
publishing, not assumed.

## Constraints

- **CSP is strict**: `script-src 'self'; style-src 'self'`. No inline `<style>`
  or `<script>`. All CSS and JS external.
- **Readable without JS.** The commands are present as text in the generated
  HTML. A copy button is progressive enhancement only.
- **Prints and emails cleanly.** This is a document other groups will
  circulate internally; it must survive being printed or pasted into a thread.
- **Brand-neutral enough to be credible.** It is a proposal to peers, not
  Liberty Hill marketing.

## Testing

- `regions-proposal.json` validates under the same rules as `config.json`
  regions: name form, no duplicates, parent defined earlier in the list.
- Every `group` named appears exactly once as a holder.
- Generated page is not stale (`sync-regions.mjs --check`).
- Commands rendered for each group match `regionPutLine()` output for that
  group's chain — the preview-equals-wire property, asserted.
- Liberty Hill's own `config.json.regions` is a consistent subset of the
  proposal: every name it carries exists in the proposal with the same parent.
  This is the test that keeps the two files from drifting apart.

## Open items — confirm before publishing

1. **Which groups exist.** Austin Mesh, San Antonio Mesh and North Texas Mesh
   are named on your say-so. Killeen and Waco were raised as maybes and are
   left unassigned pending confirmation that an organised mesh exists there.
2. **`us-tx-south` for San Antonio.** San Antonio is often called South Central
   rather than South. If their own usage differs, theirs wins.
3. **Removal command.** Verify against firmware whether a region can be
   removed, and phrase section 6 accordingly.
4. **Where it is announced.** The page is the artifact; how it reaches the
   other groups is not specified here.
