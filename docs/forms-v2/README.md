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
Rules for a request for **entry of default** (confirmed by you):
- Items **1d, 2 and 7 stay empty**. They belong to a request for court judgment.
- Item **8a** is always checked.

The new engine is checked against the original on every box. All boxes match, except these fixes:
- **"Esq., Esq."** was doubled when the attorney name in Settings already ends in "Esq." (3 fields).
- **The page-2 caption plaintiff** was left blank.
- **Item 1d** was filled with the defendant name. It is now empty.
- **Item 2d** was filled with costs. It is now empty.
- **Item 7**: the declarant name and date were filled. They are now empty. Item 7's date was one field shared with every other date on the form; it is now a separate field.

Acrobat's 26 unnamed boxes (`Check Box10`–`28`, radio groups) now have readable names, e.g. `[PRESET:8A_SCRA_SEARCH]`. They keep the template's state.

## Trying it before it goes live
- **Preview deployment (`VERCEL_ENV=preview`):** the R4D uses the new engine. Production is unchanged.
- **Which engine made a form:** a prepared form made by the new engine shows "· v2" next to its name.
- **Switches:**

  | Variable | Effect |
  |---|---|
  | `FORMS_V2_ON="CIV-100 (R4D).pdf"` | turns the new engine on for the listed forms (comma-separated) |
  | `FORMS_ENGINE=v2` | turns it on for every converted form |
  | `FORMS_ENGINE=v1` | turns it off everywhere |

## How it works
1. `templates/v2/maps/<form>.json`: old name → new name, reviewed by you. `_unnamed` names Acrobat's own boxes; `_widgets` splits one place out of a shared field (`"[DATE_SIGNED]@4"`).
2. `node scripts/rename-form-fields.js "<form>.pdf"` writes `templates/v2/<form>.pdf`. Same PDF, same positions and scripts; only the names change.
3. Generating a form uses the v2 engine per the switches above, and only for forms that have a v2 template. Everything else uses the original engine.
4. `npm test` fills the same case with both engines and fails if any field differs, other than the listed intended ones.

## Next
- Convert the other 7 forms the same way: map → rename → compare. CIV-100 (court judgment) is nearly identical to R4D.
- Then switch `FORMS_ENGINE=v2` on, and later delete `processDynamicVariables` and the `VAR_` fields.
- Generate the document-reading prompt's field list from the dictionary, so extraction and forms can never drift apart.
- The Word package (POS) uses the same `[FACT:FORMAT]` tags in its text.
