# Risoluzione problemi

## Pagina non raggiungibile

```bash
sudo systemctl status piboost --no-pager
curl -v http://127.0.0.1:3000/api/health
sudo ss -ltnp | grep ':3000'
sudo journalctl -u piboost -n 150 --no-pager
```

## Funnel non raggiungibile

```bash
sudo systemctl status tailscaled --no-pager
sudo tailscale status
sudo tailscale funnel status
curl -I https://NOME-DISPOSITIVO.NOME-TAILNET.ts.net/steamboost/
```

Ricrea Funnel:

```bash
sudo tailscale funnel reset
sudo tailscale funnel --bg 3000
```

## Netlify restituisce 500

Verifica prima Funnel. Se Funnel risponde 200 ma Netlify no, controlla `_redirects` e ripeti il deploy cancellando la cache.

## Owner non riconosciuto

```bash
grep '^OWNER_STEAM_ID64=' /opt/piboost/.env
sudo ./CONFIGURA-OWNER.sh 7656119XXXXXXXXXX
sudo systemctl restart piboost
```

Poi fai logout/login nell'interfaccia.

## Passkey non funziona

- usa il dominio HTTPS configurato;
- controlla `OWNER_RP_ID` e `OWNER_PASSKEY_ORIGINS`;
- non usare l'IP locale per la passkey remota;
- dopo un cambio dominio esegui `RESET-PASSKEY-OWNER.sh`.

## Giochi non salvati

```bash
sudo ./VERIFICA-GIOCHI.sh
sudo journalctl -u piboost -n 150 --no-pager
```
