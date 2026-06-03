## Summary

- 

## Scope

- [ ] App root is `mj-insight-vault-mvp/mj-insight-vault`
- [ ] Change is limited to the stated task
- [ ] No production data mutation code added
- [ ] No DB schema or saved data shape change unless explicitly intended

## Risk Areas

- [ ] Upload / draft recovery
- [ ] OCR / Google Vision handling
- [ ] OpenAI article structuring
- [ ] Article storage / Supabase
- [ ] Monthly rollup / stale handling
- [ ] Chat jobs / report generation
- [ ] Report evidence links / quality gate
- [ ] GitHub Actions / repository operations

## Verification

Run from `mj-insight-vault-mvp/mj-insight-vault`:

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run test:local`

## External API Checks

- [ ] Not needed
- [ ] Needed and manually verified

If manually verified, document which environment was used and confirm no secrets were logged.

## Notes

- 

