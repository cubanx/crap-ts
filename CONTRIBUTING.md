# Contributing

Pull requests are welcome.

Good fits:

- bug fixes
- clearer docs
- small CLI improvements
- edge-case tests
- compatibility fixes for common coverage output

Smaller changes are easier to deal with, larger changes may require more discussion.

## Checks

Run these before opening a PR:

```sh
npm run check
npm run validate
```

## Taste

- CRAP means cyclomatic complexity plus coverage.
- Keep coverage input explicit.
- Prefer obvious flags over clever ones.
- Add tests for behavior changes.
- Avoid framework-specific assumptions unless they are configurable.

Gotta keep the CRAP low!
