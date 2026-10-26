[AI]

# pi-alt-provider

A Pi extension that creates separately named providers by inheriting an existing provider and overriding selected settings. The original provider is not changed.

Requires **Pi 1.3.0 or newer** (`@earendil-works` packages) and Node.js 22.19 or newer. There are no additional runtime dependencies.

## Configure

Edit **`~/.pi/agent/altprovider.json`**, alongside Pi's other user-level configuration files. As with pi-auto-router, setting `PI_CODING_AGENT_DIR` changes the agent directory; the file is then `<PI_CODING_AGENT_DIR>/altprovider.json`.

For a fresh setup, copy the example without overwriting an existing configuration:

```sh
mkdir -p ~/.pi/agent
cp -n config.example.json ~/.pi/agent/altprovider.json
```

There is no project- or package-local config discovery. If you previously used this extension's local `config.json`, move it to the new path. The configuration format is unchanged.

A minimal `altprovider.json`:

```json
{
  "providers": [
    {
      "name": "openai-proxy",
      "originalProvider": "openai",
      "overrides": {
        "baseUrl": "https://proxy.example.com/v1"
      }
    }
  ]
}
```

- `name`: a new provider ID. It must not replace an existing provider.
- `originalProvider`: an existing built-in provider ID, or a provider defined in Pi's `models.json`.
- `overrides`: optional settings listed below. Omitted settings continue to come from the original provider.

Multiple entries are supported. Names must be unique and contain only letters, digits, dots, underscores, or hyphens. Inheriting another entry in this file or a provider supplied only by another extension is not supported.

### Supported overrides

| Setting | Meaning |
| --- | --- |
| `baseUrl` | HTTP(S) endpoint or environment template, expanded and validated at startup, then applied to every inherited model and request, including credential-dependent endpoints. |
| `apiKey` | Use a different API key instead of the original provider's credentials. |
| `headers` | Merge custom request headers over the original headers, case-insensitively. Use `null` to remove a header. |
| `compat` | Merge Pi compatibility settings into the alternative's inherited chat models. Unspecified settings and the original provider are preserved. |
| `name` | Optional display name; the entry's `name` remains its provider ID. |

`baseUrl`, display `name`, `apiKey`, and individual header values accept `$ENV_VAR` or `${ENV_VAR}` references, either as the whole value or embedded in text (for example, `https://${PROXY_HOST}/v1` or `Bearer $TOKEN`). Use `$$` for a literal dollar sign. Substituted values are not recursively expanded.

Export variables before launching Pi. `baseUrl` and display `name` are resolved when the configuration loads; URL validation happens after expansion. API keys and headers are resolved at request time, including request-scoped environment values. Missing or empty variables fail instead of silently falling back. Shell commands are not supported. Explicit request-time keys and headers take precedence over configured overrides.

For example, with `ANTHROPIC_PROXY_BASE_URL` set to `https://proxy.example.com/anthropic`:

```json
{
  "providers": [
    {
      "name": "anthropic-proxy",
      "originalProvider": "anthropic",
      "overrides": {
        "baseUrl": "$ANTHROPIC_PROXY_BASE_URL",
        "apiKey": "$ANTHROPIC_PROXY_API_KEY",
        "headers": {
          "X-Proxy-Token": "${PROXY_TOKEN}",
          "X-Unwanted-Header": null
        }
      }
    }
  ]
}
```

Models, capabilities, prices, limits, thinking settings, API implementations, discovery, image/classifier operations, and deferred responses come from the original provider. Original `models.json` settings, including model-specific headers, are retained. New catalog models are inherited without maintaining a copied list. Use `/reload` after changing this extension's configuration.

Missing configuration or an empty provider list is a no-op. Malformed configuration, duplicate names, unknown originals, and unsupported override settings are reported as extension errors before any providers are registered.

### Endpoint compatibility

Keep endpoint-specific compatibility settings in **`altprovider.json`**, alongside the alternative's endpoint and authentication overrides. `overrides.compat` uses Pi's compatibility schema; flags are merged per key, and nested routing/template options retain unspecified keys. Image and classifier models are not changed.

For an Anthropic-compatible endpoint that rejects `messages.N.output_config`, add `compat` to its existing `overrides`, keeping your current endpoint and key settings:

```json
{
  "providers": [
    {
      "name": "enmaas-anthropic",
      "originalProvider": "anthropic",
      "overrides": {
        "baseUrl": "$ANTHROPIC_PROXY_BASE_URL",
        "apiKey": "$ANTHROPIC_PROXY_API_KEY",
        "compat": {
          "supportsMidConvoEffort": false
        }
      }
    }
  ]
}
```

This keeps adaptive thinking and the requested effort level, but sends effort at the request level instead of inserting effort-only system messages. It also omits the associated thinking-binding controls and beta headers. Changing effort may then invalidate the prompt cache. Apply compatibility overrides only for differences confirmed on your endpoint; changing `baseUrl` alone does not disable native Anthropic features.

If Vertex AI rejects `structured_outputs` under `vertexai.allowedPartnerModelFeatures`, also add `"supportsStrictTools": false` to the same `compat` object. This disables strict tool generation, not ordinary tool calling or Pi's tool-argument validation. Tools explicitly requiring strict generation still fail rather than silently downgrading. To retain strict generation instead, an organization administrator must [allow the feature for the affected model](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/control-model-access).

No `models.json` entry is needed for these settings. Pi's optional `models.json` metadata overlays still work and apply after the alternative's settings. Use `/reload` after changing the configuration.

## Load

Install directly from GitHub:

```sh
pi install git:github.com/slintes/pi-alt-provider
```

Or try a local checkout without changing your Pi settings:

```sh
pi -e /absolute/path/to/pi-alt-provider/index.ts
```

Or install the directory as a local package:

```sh
pi install /absolute/path/to/pi-alt-provider
```

Then use `/model` to select a model under the new provider name, or select it at startup:

```sh
pi -e ./index.ts --provider openai-proxy --model gpt-4.1
```

For local development and tests:

```sh
npm install --ignore-scripts
npm run check
npm test
```

Pi supplies the runtime dependencies when loading the extension; `npm install` here is only needed for development.

## Authentication and security

Without `apiKey`, authenticate **the original provider** with `/login` or its usual environment variables. The alternative reuses that authentication, including stored OAuth credentials and token refresh. It deliberately does not add a separate `/login` entry or copy credentials. With an `apiKey` override, configure that key instead. The model picker only lists alternatives whose key or original authentication is configured.

**An overridden endpoint receives the original provider's credentials unless you override the key or relevant authentication headers. Only use endpoints you trust.** The endpoint must speak the original provider's API; changing `baseUrl` does not translate protocols.

Prefer environment references over literal secrets. Your `altprovider.json` stays outside the package and is not bundled or overwritten by package updates. Loading the extension does not rewrite this file or Pi's other configuration files.

Tests run against mocked providers and a loopback HTTP server; they do not call external model services.
