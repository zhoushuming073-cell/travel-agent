# Security Policy

## Reporting a vulnerability

Do not disclose API keys, tokens, cookies, private provider URLs, personal data, or exploitable vulnerability details in a public issue, discussion, pull request, screenshot, or log.

This repository does not publish a dedicated security email address. To request a private reporting channel, contact the maintainer through the [zhoushuming073-cell GitHub profile](https://github.com/zhoushuming073-cell) with only a brief, non-sensitive summary. If GitHub displays a private vulnerability reporting option in the repository's **Security** tab, prefer that channel.

Include the affected component, impact, reproduction conditions, and a proposed mitigation when it is safe to share them privately. Remove all real credentials and personal data from examples.

## Supported versions

Until stable releases are established, security fixes target the latest revision of `main`. Older commits are not maintained as separate supported versions.

## Secret exposure

If a real credential is committed or posted publicly, treat it as compromised: revoke or rotate it at the provider first, then remove it from the repository and any published artifacts. Rewriting Git history does not replace credential rotation.
