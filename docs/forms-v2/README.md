# Forms v2: standard field names + one fact dictionary

**Status:** first form converted (CIV-100 Request for Entry of Default). This is on a branch and **off by default**: the live site still uses the original engine.

## What changed
| Before | After |
|---|---|
| 203 field names, 27 `VAR_` composites, 490 lines of formatting code (`processDynamicVariables`) | Field name = **fact + format**, e.g. `[DEFENDANT:ET_AL]`, `[COURT_COUNTY:UPPER:BOLD]` |
| A new format meant new code and a new `VAR_` field | ~30 formats in one file (`lib/forms/formatters.js`), usable on every form |
| Extraction keys, field names and composition rules kept in sync by hand | One fact dictionary (`lib/forms/dictionary.js`): where each fact comes from, plus the hint the AI uses to find it |
| `_P2` copy fields filled by special code | Give both fields the same name, or add `#p2`, and the same fact fills both |
| Dates and amounts formatted in code | Fields that carry an Acrobat format (e.g. "mmmm d, yyyy", 2 decimals) are formatted to match that, with no code |

- **Naming rules and every fact, format and checkbox condition:** [FIELD-NAMING.md](FIELD-NAMING.md)
- **CIV-100 (R4D), old vs new output, field by field:** [CIV-100-R4D-comparison.md](CIV-100-R4D-comparison.md)

## CIV-100 (R4D) result
**71 of 76 fields identical.** The other 5 are intended:
- **Fixed:** "Esq., Esq." doubled when the attorney name in Settings already ends in "Esq." (3 fields).
- **Fixed:** the page-2 caption plaintiff was left blank.
- **Changed:** item 1d (court judgment against…) now stays blank on a request for *entry of default*. It had been filled with the defendant name.

**Questions for you:**
1. **Item 2 amount table** (demand, costs, totals, credits, balances): it stays blank as before, except Costs and Attorney fees when the case has them. Should a request for entry of default show the complaint demand in 2a? It's one line in the map either way.
2. **Item 1d on the request for entry of default:** OK to leave it blank?

## How it works
1. `templates/v2/maps/<form>.json`: old name → new name, reviewed by you.
2. `node scripts/rename-form-fields.js "<form>.pdf"` writes `templates/v2/<form>.pdf`. Same PDF, same positions and scripts; only the names change.
3. Generating a form uses the v2 engine when asked (`engine: "v2"`) or when `FORMS_ENGINE=v2` is set, and only for forms that have a v2 template. Everything else uses the original engine.
4. `npm test` fills the same case with both engines and fails if any field differs, other than the listed intended ones.

## Next
- Convert the other 7 forms the same way: map → rename → compare. CIV-100 (court judgment) is nearly identical to R4D.
- Then switch `FORMS_ENGINE=v2` on, and later delete `processDynamicVariables` and the `VAR_` fields.
- Generate the document-reading prompt's field list from the dictionary, so extraction and forms can never drift apart.
- The Word package (POS) uses the same `[FACT:FORMAT]` tags in its text.
