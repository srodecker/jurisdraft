# CIV-100 (R4D).pdf: original engine vs forms v2

96 of 102 fields identical.

| Old field | New field | Original output | New output | |
|---|---|---|---|---|
| `[VAR_ATTY_WITH_SBN]` | `[ATTORNEYS:NAME_SBN]` | Gwen H. Ribar, Esq., SBN 188024; Sabaa Ghomashchi, Esq., Esq., SBN 352285 | Gwen H. Ribar, Esq., SBN 188024; Sabaa Ghomashchi, Esq., SBN 352285 | **Fixed: original doubled "Esq., Esq." when the attorney name in Settings already ends in Esq.** |
| `[ATTY_SBN]` | `[ATTORNEY_1_SBN]` | 188024 | 188024 | ✓ |
| `[VAR_FIRM_FULL_NAME]` | `[FIRM_NAME:TITLE]` | Wright, Finlay & Zak, LLP | Wright, Finlay & Zak, LLP | ✓ |
| `[FIRM_ADDRESS]` | `[FIRM_STREET]` | 4665 MacArthur Court, Suite 200 | 4665 MacArthur Court, Suite 200 | ✓ |
| `[FIRM_CITY]` | `[FIRM_CITY]` | Newport Beach | Newport Beach | ✓ |
| `[FIRM_STATE]` | `[FIRM_STATE]` | CA | CA | ✓ |
| `[FIRM_ZIP]` | `[FIRM_ZIP]` | 92660 | 92660 | ✓ |
| `[FIRM_PHONE]` | `[FIRM_PHONE]` | (949) 477-5050 | (949) 477-5050 | ✓ |
| `[FIRM_FAX]` | `[FIRM_FAX]` | (949) 608-9142 | (949) 608-9142 | ✓ |
| `[VAR_ATTY_EMAIL]` | `[ATTORNEYS:EMAILS]` | gribar@wrightlegal.net, sghomashchi@wrightlegal.net | gribar@wrightlegal.net, sghomashchi@wrightlegal.net | ✓ |
| `[VAR_PLAINTIFF_NAME]` | `[PLAINTIFF:WITH_ROLE]` | Plaintiff, Kinecta Federal Credit Union | Plaintiff, Kinecta Federal Credit Union | ✓ |
| `[VAR_COURT_COUNTY]` | `[COURT_COUNTY:UPPER:BOLD]` | KERN | KERN | ✓ |
| `[COURT_STREET_ADDRESS]` | `[COURT_STREET]` | 1215 Truxtun Avenue | 1215 Truxtun Avenue | ✓ |
| `[COURT_MAILING_ADDRESS]` | `[COURT_MAILING]` | Same as street address | Same as street address | ✓ |
| `[COURT_CITY_ZIP]` | `[COURT_CITY_ZIP]` | Bakersfield, CA 93301 | Bakersfield, CA 93301 | ✓ |
| `[COURT_BRANCH_NAME]` | `[COURT_BRANCH]` | Metropolitan Division | Metropolitan Division | ✓ |
| `[PLAINTIFF_NAME]` | `[PLAINTIFF]` | Kinecta Federal Credit Union | Kinecta Federal Credit Union | ✓ |
| `[VAR_DEFENDANT_NAME_ET_AL]` | `[DEFENDANT:ET_AL]` | Erick Alonso Acevedo, et al. | Erick Alonso Acevedo, et al. | ✓ |
| `[PLAINTIFF_NAME_P2]` | `[PLAINTIFF#p2]` | · | Kinecta Federal Credit Union | **Fixed: original left the page-2 caption plaintiff blank** |
| `[DEFENDANT_NAME_P2]` | `[DEFENDANT:ET_AL#p2]` | Erick Alonso Acevedo, et al. | Erick Alonso Acevedo, et al. | ✓ |
| `[CASE_NUMBER]` | `[CASE_NUMBER]` | 25CLB01343 | 25CLB01343 | ✓ |
| `[IS_ENTRY]` | `[PRESET:REQUEST_ENTRY_OF_DEFAULT]` | ☑ | ☑ | ✓ |
| `[IS_COURT_JUDGMENT]` | `[PRESET:REQUEST_COURT_JUDGMENT]` | ☐ | ☐ | ✓ |
| `[COMPLAINT_FILED]` | `[COMPLAINT_FILED:LONG]` | October 28, 2025 | October 28, 2025 | ✓ |
| `[VAR_DEFENDANT_INDIVIDUAL]` | `[DEFENDANT:INDIVIDUAL]` | Erick Alonso Acevedo, an individual | Erick Alonso Acevedo, an individual | ✓ |
| `[AGAINST_DEFENDANT_NAME]` | `[MANUAL:1D_COURT_JUDGMENT_AGAINST]` | Erick Alonso Acevedo | · | **Fixed: item 1d (court judgment) stays blank on a request for entry of default — it was filled with the defendant name** |
| `[DATE1]` | `[MANUAL:1E3_DEFAULT_PREVIOUSLY_ENTERED_ON]` | · | · | ✓ |
| `[JUDGMENT_TOTAL_AMOUNT]` | `[MANUAL:2A_DEMAND_AMOUNT]` | · | · | ✓ |
| `[CREDIT_1]` | `[MANUAL:2A_DEMAND_CREDITS]` | · | · | ✓ |
| `[VAR_JUDGMENT_TOTAL_AMOUNT]` | `[MANUAL:2A_DEMAND_BALANCE]` | · | · | ✓ |
| `[AMUONT_2]` | `[MANUAL:2B1_SPECIAL_DAMAGES]` | · | · | ✓ |
| `[CREDIT_2]` | `[MANUAL:2B1_SPECIAL_CREDITS]` | · | · | ✓ |
| `[BALANCE_2]` | `[MANUAL:2B1_SPECIAL_BALANCE]` | · | · | ✓ |
| `[AMOUNT_3]` | `[MANUAL:2B2_GENERAL_DAMAGES]` | · | · | ✓ |
| `[CREDIT_3]` | `[MANUAL:2B2_GENERAL_CREDITS]` | · | · | ✓ |
| `[BALANCE_3]` | `[MANUAL:2B2_GENERAL_BALANCE]` | · | · | ✓ |
| `[AMOUNT_4]` | `[MANUAL:2C_INTEREST]` | · | · | ✓ |
| `[CREDIT_4]` | `[MANUAL:2C_INTEREST_CREDITS]` | · | · | ✓ |
| `[BALANCE_4]` | `[MANUAL:2C_INTEREST_BALANCE]` | · | · | ✓ |
| `[COSTS]` | `[MANUAL:2D_COSTS]` | 435.00 | · | **Fixed: item 2 (judgment amounts) stays blank on a request for entry of default — costs were filled in 2d** |
| `[CREDIT_5]` | `[MANUAL:2D_COSTS_CREDITS]` | · | · | ✓ |
| `[VAR_COSTS]` | `[MANUAL:2D_COSTS_BALANCE]` | · | · | ✓ |
| `[ATTY_FEES]` | `[MANUAL:2E_ATTORNEY_FEES]` | · | · | ✓ |
| `[CREDIT_6]` | `[MANUAL:2E_FEES_CREDITS]` | · | · | ✓ |
| `[VAR_ATTY_FEES]` | `[MANUAL:2E_FEES_BALANCE]` | · | · | ✓ |
| `[TOTAL_AMOUNT]` | `[MANUAL:2F_TOTAL]` | · | · | ✓ |
| `[CREDIT_7]` | `[MANUAL:2F_TOTAL_CREDITS]` | · | · | ✓ |
| `[VAR_TOTAL_AMOUNT]` | `[MANUAL:2F_TOTAL_BALANCE]` | · | · | ✓ |
| `[DAILY_DAMAGE]` | `[MANUAL:2G_DAILY_DAMAGES_RATE]` | · | · | ✓ |
| `[DATE]` | `[MANUAL:2G_DAILY_DAMAGES_FROM]` | · | · | ✓ |
| `[DATE_SIGNED]` | `[TODAY]` | October 17, 2026 | October 17, 2026 | ✓ |
| `[VAR_ATTY_NAME2]` | `[ATTORNEY_2:ESQ]` | Sabaa Ghomashchi, Esq., Esq. | Sabaa Ghomashchi, Esq. | **Fixed: same "Esq., Esq." doubling** |
| `[DID_NOT]` | `[PRESET:4_LDA_DID_NOT]` | ☐ | ☐ | ✓ |
| `[ASSISTANT_NAME]` | `[MANUAL:4A_ASSISTANT_NAME]` | · | · | ✓ |
| `[ASSISTANT_ADDRESS]` | `[MANUAL:4B_ASSISTANT_ADDRESS]` | · | · | ✓ |
| `[ASSISTANT_PHONE]` | `[MANUAL:4C_ASSISTANT_PHONE]` | · | · | ✓ |
| `[COUNTY_REGISTRATION]` | `[MANUAL:4D_COUNTY_OF_REGISTRATION]` | · | · | ✓ |
| `[REGISTRATION_NO]` | `[MANUAL:4E_REGISTRATION_NO]` | · | · | ✓ |
| `[DATE6]` | `[MANUAL:4F_REGISTRATION_EXPIRES]` | · | · | ✓ |
| `[NOT_CONTRACT]` | `[PRESET:5A_NOT_UNRUH]` | ☐ | ☐ | ✓ |
| `[NOT_CONDITIONAL]` | `[PRESET:5B_NOT_REES_LEVERING]` | ☐ | ☐ | ✓ |
| `[NOT_OBLIGATION]` | `[PRESET:5C_NOT_395B]` | ☐ | ☐ | ✓ |
| `[NOTMAILED]` | `[MANUAL:6A_NOT_MAILED_NAMES]` | · | · | ✓ |
| `[VAR_DEFENDANT_NAME_WITH_ADDRESS_NO_INDIVIDUAL]` | `[DEFENDANT_ADDRESS:NAME_ADDRESS]` | Erick Alonso Acevedo<br>123 Main St<br>Bakersfield, CA 93301 | Erick Alonso Acevedo<br>123 Main St<br>Bakersfield, CA 93301 | ✓ |
| `[PRINT_NAME1]` | `[MANUAL:4_6_DECLARANT_NAME]` | Shane Rodecker | Shane Rodecker | ✓ |
| `[FEES1]` | `[MANUAL:7A_CLERKS_FILING_FEES]` | · | · | ✓ |
| `[FEES2]` | `[MANUAL:7B_PROCESS_SERVER_FEES]` | · | · | ✓ |
| `[OTHER]` | `[MANUAL:7C_OTHER_COST_DESCRIPTION]` | · | · | ✓ |
| `[FEES3]` | `[MANUAL:7C_OTHER_COST_AMOUNT]` | · | · | ✓ |
| `[OTHER2]` | `[MANUAL:7D_OTHER_COST_DESCRIPTION]` | · | · | ✓ |
| `[FEES4]` | `[MANUAL:7D_OTHER_COST_AMOUNT]` | · | · | ✓ |
| `[FEES5]` | `[MANUAL:7E_COSTS_TOTAL]` | · | · | ✓ |
| `[VAR_ATTY2_NAME]` | `[MANUAL:7_DECLARANT_NAME]` | Sabaa Ghomashchi, Esq., SBN: 352285 | · | **Fixed: item 7 (memorandum of costs) stays blank on a request for entry of default — the declarant name was filled** |
| `[DATE9]` | `[MANUAL:8D_DISCHARGED_FROM_MILITARY_ON]` | · | · | ✓ |
| `[SPECIFY]` | `[MANUAL:8F_OTHER_MILITARY_STATUS]` | · | · | ✓ |
| `[PRINT_NAME_1]` | `[MANUAL:8_DECLARANT_NAME]` | · | · | ✓ |
| `Check Box10` | `[PRESET:CAPTION_CLERKS_JUDGMENT]` | ☐ | ☐ | ✓ |
| `Check Box11` | `[PRESET:1C_ENTER_DEFAULT]` | ☑ | ☑ | ✓ |
| `Check Box12` | `[PRESET:1D_COURT_JUDGMENT]` | ☐ | ☐ | ✓ |
| `Check Box13` | `[PRESET:1E_CLERKS_JUDGMENT]` | ☐ | ☐ | ✓ |
| `Check Box14` | `[PRESET:1E1_RESTITUTION]` | ☐ | ☐ | ✓ |
| `Check Box15` | `[PRESET:1E1_INCLUDE_OCCUPANTS]` | ☐ | ☐ | ✓ |
| `Check Box16` | `[PRESET:1E2_CCP_585A]` | ☐ | ☐ | ✓ |
| `Check Box17` | `[PRESET:1E3_DEFAULT_PREVIOUSLY_ENTERED]` | ☐ | ☐ | ✓ |
| `Check Box18` | `[PRESET:3_UNLAWFUL_DETAINER_ASSISTANT]` | ☐ | ☐ | ✓ |
| `Check Box19` | `[PRESET:5_DECLARATION_585_5]` | ☐ | ☐ | ✓ |
| `Check Box20` | `[PRESET:7F_COSTS_WAIVED]` | ☐ | ☐ | ✓ |
| `Check Box21` | `[PRESET:8A_SCRA_SEARCH]` | ☑ | ☑ | ✓ |
| `Check Box22` | `[PRESET:8B_REGULAR_COMMUNICATION]` | ☐ | ☐ | ✓ |
| `Check Box23` | `[PRESET:8C_RECENTLY_CONTACTED]` | ☐ | ☐ | ✓ |
| `Check Box24` | `[PRESET:8D_DISCHARGED]` | ☐ | ☐ | ✓ |
| `Check Box25` | `[PRESET:8E_NOT_ELIGIBLE]` | ☐ | ☐ | ✓ |
| `Check Box26` | `[PRESET:8E_INCARCERATED]` | ☐ | ☐ | ✓ |
| `Check Box27` | `[PRESET:8E_BUSINESS_ENTITY]` | ☐ | ☐ | ✓ |
| `Check Box28` | `[PRESET:8F_OTHER]` | ☐ | ☐ | ✓ |
| `GROUP2` | `[PRESET:4_LDA_DID_OR_DID_NOT]` | (no field) | (no field) | ✓ |
| `GROUP3` | `[PRESET:5A_UNRUH_IS_OR_IS_NOT]` | (no field) | (no field) | ✓ |
| `GROUP4` | `[PRESET:5B_REES_LEVERING_IS_OR_IS_NOT]` | (no field) | (no field) | ✓ |
| `GROUP5` | `[PRESET:5C_395B_IS_OR_IS_NOT]` | (no field) | (no field) | ✓ |
| `GROUP6` | `[PRESET:6_MAILED_OR_NOT_MAILED]` | (no field) | (no field) | ✓ |
| `Group1` | `[PRESET:CLERK_DEFAULT_ENTERED]` | (no field) | (no field) | ✓ |
| `Group0` | `[PRESET:CLERK_DEFAULT_NOT_ENTERED]` | (no field) | (no field) | ✓ |
