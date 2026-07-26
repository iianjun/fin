# Commit Convention

Keep each commit focused on one logical change and use the following message format:

```text
<type>(<optional-scope>): <summary>
```

Omit the scope when it does not add useful context.

## Types

- `feat`: introduce user-visible behavior
- `fix`: correct faulty behavior
- `docs`: change documentation only
- `refactor`: restructure code without changing behavior
- `test`: add or change tests only
- `chore`: maintain tooling, dependencies, or repository configuration

## Summary

- Use an imperative phrase.
- Start with a lowercase letter.
- Do not end with a period.

Add a body when the reason or trade-off is not clear from the summary.

## Examples

```text
feat(core): add account creation
fix(mcp): reject malformed requests
docs: add branch convention
```
