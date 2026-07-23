# Pannello owner

Configura lo SteamID64:

```bash
sudo ./CONFIGURA-OWNER.sh 7656119XXXXXXXXXX
```

Configura il dominio HTTPS:

```bash
sudo ./CONFIGURA-DOMINIO.sh https://boost.example.com
```

Poi:

1. accedi a `https://boost.example.com/steamboost/` con l'account owner;
2. apri **Amministrazione**;
3. registra la passkey;
4. usa `https://boost.example.com/steamboost/admin`.

Gli altri utenti vengono reindirizzati alla dashboard normale. Le API admin restituiscono 401/403.

Reset passkey:

```bash
sudo ./RESET-PASSKEY-OWNER.sh
```
