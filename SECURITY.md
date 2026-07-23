# Sicurezza

## Segnalazione vulnerabilità

Non pubblicare credenziali, token o dati personali in una issue pubblica. Apri una segnalazione privata tramite GitHub Security Advisories oppure contatta direttamente il maintainer del repository.

## File che non devono mai finire su GitHub

```text
/opt/piboost/.env
/opt/piboost/data/
backend/.env
backup contenenti .env o data
chiavi private e certificati
```

`.gitignore` esclude questi file, ma controlla sempre `git status` prima del push.

## Protezioni implementate

- refresh token Steam cifrati con `MASTER_KEY`;
- password Steam non salvata;
- sessioni applicative casuali e hashate;
- owner identificato con SteamID64;
- passkey WebAuthn legata a `OWNER_RP_ID`;
- cookie owner `HttpOnly`, `SameSite=Strict` e `Secure` su HTTPS;
- verifica origine e token CSRF per le mutazioni admin;
- rate limiting in memoria sugli endpoint di autenticazione;
- Helmet e Content Security Policy;
- servizio systemd senza privilegi root e con filesystem protetto.

## Configurazione raccomandata

- usa HTTPS;
- configura un solo dominio esatto in `OWNER_RP_ID`;
- limita `OWNER_PASSKEY_ORIGINS` e `OWNER_ALLOWED_ORIGINS`;
- lascia `FRAME_ANCESTORS='self'` salvo necessità reali;
- non aprire direttamente la porta 3000 sul router;
- preferisci Tailscale Funnel o un reverse proxy aggiornato;
- proteggi SSH con chiavi, aggiornamenti e firewall;
- mantieni Node.js, npm e dipendenze aggiornati;
- crea backup cifrati e con permessi 600.

## Limiti

PiBoost usa librerie e protocolli Steam non ufficiali. Non può garantire compatibilità futura né conformità con eventuali termini di terze parti. L'uso è a rischio dell'utente.
