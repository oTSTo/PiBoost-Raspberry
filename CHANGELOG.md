# Changelog

## 4.1.1

- avviso "Sessione Steam scaduta" quando Steam rifiuta l'accesso salvato (token
  scaduto o revocato): stato dedicato `session_expired`, riquadro con il
  pulsante per rifare l'accesso, conteggio in `/api/health` (`attention`) e
  stato leggibile nel pannello owner;
- `index.html` carica CSS e JS con percorsi relativi: funziona anche dietro un
  reverse proxy che aggiunge un prefisso (es. `/raspberry/steamboost/`);
- `package-lock.json` incluso nel repository (era citato nella 4.1.0 ma mancava).
- dipendenze senza vulnerabilita' note (`npm audit`): aggiornati `ip-address` e
  `qs`, `adm-zip` forzato alla 0.6.1 con un override (steam-user lo usa solo per i
  download dal CDN di Steam, che PiBoost non fa).

## 4.1.0 — GitHub Release

- repository ripulito da configurazioni personali;
- installer interattivo per SteamID64, dominio HTTPS e Tailscale;
- configurazione WebAuthn generica;
- origini e `frame-ancestors` gestiti tramite `.env`;
- aggiornamento che conserva integralmente la configurazione esistente;
- README completo con installazione, Tailscale, Netlify, backup e GitHub;
- `.gitignore`, `.gitattributes`, lockfile e GitHub Actions;
- script PowerShell per pubblicare un nuovo repository;
- mantenute tutte le funzionalità della 4.0.2.

## 4.0.2

- salvataggio automatico dei giochi selezionati;
- recupero giochi dall'ultimo boost e dallo storico;
- persistenza separata per ogni utente.

## 4.0.1

- transizioni più fluide tra dashboard e pannello owner;
- rimossa la dicitura “Multiutente · Gratuito”.

## 4.0.0

- pannello owner con SteamID64 e passkey;
- persistenza di giochi, impostazioni, ore, date e storico;
- amministrazione utenti, sistema, log e manutenzione.
