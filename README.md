# PiBoost Raspberry

Dashboard self-hosted per Raspberry Pi che gestisce più account Steam, ricorda giochi e impostazioni per ogni utente, registra ore/date delle sessioni e include un pannello owner protetto da SteamID64 e passkey WebAuthn.

> [!IMPORTANT]
> Progetto indipendente e non affiliato a Valve o Steam. Usa il software solo sui tuoi account e nel rispetto dei termini applicabili. PiBoost usa librerie Steam non ufficiali: modifiche lato Steam possono richiedere aggiornamenti del progetto.

## Funzionalità

- login Steam con nome/password + Steam Guard oppure QR Code;
- più account Steam contemporaneamente;
- fino a 32 giochi per sessione/account;
- selezione giochi salvata automaticamente;
- preferiti e impostazioni separate per ogni utente;
- continua boost dopo logout;
- avvio automatico del boost dopo il riavvio del Raspberry;
- pausa quando viene rilevato un gioco reale e ripresa automatica;
- storico con data, durata, giochi e motivo di arresto;
- ore boostate per gioco, totali giornalieri e numero di sessioni;
- pannello owner su `/steamboost/admin`;
- owner identificato tramite SteamID64;
- secondo controllo con passkey WebAuthn;
- dati e refresh token cifrati sul Raspberry;
- servizio systemd con riavvio automatico;
- backup automatico prima degli aggiornamenti.

## Requisiti

- Raspberry Pi 4 o superiore, oppure altro computer Linux ARM64/x64;
- Ubuntu/Debian recente;
- Node.js 20 o superiore;
- npm;
- connessione Internet;
- un dominio HTTPS per usare le passkey owner da remoto;
- facoltativo: Tailscale Funnel per pubblicare il servizio senza aprire porte sul router;
- facoltativo: Netlify per mostrare PiBoost sotto un percorso del proprio sito.

## Struttura

```text
PiBoost-Raspberry/
├── backend/
│   ├── public/                 # Interfaccia utente e admin
│   ├── scripts/                # Installazione, aggiornamento e rimozione
│   ├── src/                    # Backend Node.js
│   ├── data/.gitkeep           # I dati reali non vengono pubblicati
│   ├── .env.example
│   ├── package.json
├── docs/
├── netlify/
├── scripts/
├── INSTALLA.sh
├── AGGIORNA.sh
├── RIMUOVI.sh
├── CONFIGURA-OWNER.sh
├── CONFIGURA-DOMINIO.sh
├── RESET-PASSKEY-OWNER.sh
└── VERIFICA.sh
```

## Installazione rapida sul Raspberry

### 1. Installa Git, curl e unzip

```bash
sudo apt update
sudo apt install -y git curl unzip ca-certificates
```

### 2. Installa Node.js 20 o superiore

Verifica prima:

```bash
node -v
npm -v
```

Se Node.js non è installato o è troppo vecchio, installa una versione LTS recente. Un metodo semplice su Ubuntu/Debian è usare NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### 3. Clona il repository

```bash
cd /home/$USER
git clone https://github.com/TUO-USERNAME/PiBoost-Raspberry.git
cd PiBoost-Raspberry
```

### 4. Rendi eseguibili gli script

```bash
chmod +x *.sh backend/scripts/*.sh
```

### 5. Installa PiBoost

```bash
sudo ./INSTALLA.sh
```

Lo script chiede:

1. SteamID64 owner di 17 cifre;
2. dominio HTTPS pubblico, per esempio `https://boost.example.com`;
3. URL Tailscale Funnel opzionale.

Lo script:

- genera automaticamente `MASTER_KEY`;
- crea `/opt/piboost/.env`;
- installa le dipendenze;
- crea `/etc/systemd/system/piboost.service`;
- abilita l’avvio automatico;
- avvia PiBoost sulla porta 3000.

### 6. Controlla il servizio

```bash
sudo systemctl status piboost --no-pager
curl -s http://127.0.0.1:3000/api/health
```

Apri dalla rete locale:

```text
http://IP_DEL_RASPBERRY:3000/steamboost/
```

## Configurazione owner

L’owner è riconosciuto tramite SteamID64. Per cambiarlo:

```bash
cd /home/$USER/PiBoost-Raspberry
sudo ./CONFIGURA-OWNER.sh 7656119XXXXXXXXXX
```

Poi fai logout/login con l’account owner e apri:

```text
https://TUO-DOMINIO/steamboost/admin
```

Al primo accesso viene richiesta la registrazione di una passkey. Gli altri account non vedono il collegamento Amministrazione e vengono reindirizzati alla dashboard normale.

Per azzerare soltanto le passkey owner:

```bash
sudo ./RESET-PASSKEY-OWNER.sh
```

## Configurare o cambiare dominio HTTPS

```bash
sudo ./CONFIGURA-DOMINIO.sh https://boost.example.com
```

Con Tailscale Funnel come origine aggiuntiva:

```bash
sudo ./CONFIGURA-DOMINIO.sh \
  https://boost.example.com \
  https://nome-dispositivo.nome-tailnet.ts.net
```

La modifica del dominio azzera le passkey perché WebAuthn lega le credenziali al dominio. I giochi, le ore e gli account non vengono cancellati.

## Pubblicazione con Tailscale Funnel

Installa Tailscale:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Pubblica PiBoost:

```bash
sudo tailscale funnel --bg 3000
sudo tailscale funnel status
```

Dovresti ottenere un URL simile a:

```text
https://nome-dispositivo.nome-tailnet.ts.net
```

La dashboard sarà:

```text
https://nome-dispositivo.nome-tailnet.ts.net/steamboost/
```

Per rimuovere la configurazione Funnel:

```bash
sudo tailscale funnel reset
```

## Collegamento al proprio sito tramite Netlify

Nel repository del sito Netlify aggiungi al file `_redirects`:

```text
/steamboost      https://NOME-DISPOSITIVO.NOME-TAILNET.ts.net/steamboost/       200!
/steamboost/*    https://NOME-DISPOSITIVO.NOME-TAILNET.ts.net/steamboost/:splat 200!
```

Metti queste regole prima di eventuali regole generiche come `/* /index.html 200`.

Il template è disponibile in [`netlify/_redirects.example`](netlify/_redirects.example).

## Aggiornamento

Da una nuova copia del repository:

```bash
cd /home/$USER/PiBoost-Raspberry
git pull
sudo ./AGGIORNA.sh
```

Lo script conserva:

- `/opt/piboost/.env`;
- `/opt/piboost/data`;
- account e token cifrati;
- giochi selezionati;
- preferiti;
- impostazioni;
- ultimo boost;
- ore e date;
- storico;
- passkey owner.

Prima dell’aggiornamento crea un backup in:

```text
/opt/piboost-backups/
```

## Backup manuale

```bash
sudo mkdir -p /opt/piboost-backups
sudo tar -czf \
  "/opt/piboost-backups/piboost-manuale-$(date +%Y%m%d-%H%M%S).tar.gz" \
  -C /opt/piboost data .env
```

Elenco backup:

```bash
sudo ls -lh /opt/piboost-backups/
```

## Ripristino backup

Ferma il servizio:

```bash
sudo systemctl stop piboost
```

Ripristina il backup, sostituendo il nome del file:

```bash
sudo tar -xzf /opt/piboost-backups/NOME-BACKUP.tar.gz -C /opt/piboost
sudo chown -R "$USER":"$(id -gn)" /opt/piboost
sudo chmod 600 /opt/piboost/.env
sudo chmod 700 /opt/piboost/data
sudo systemctl start piboost
```

Controlla:

```bash
curl -s http://127.0.0.1:3000/api/health
```

## Comandi utili

```bash
# Stato
sudo systemctl status piboost --no-pager

# Avvio / stop / riavvio
sudo systemctl start piboost
sudo systemctl stop piboost
sudo systemctl restart piboost

# Avvio automatico
sudo systemctl enable piboost
sudo systemctl disable piboost

# Log recenti
sudo journalctl -u piboost -n 150 --no-pager

# Log in tempo reale
sudo journalctl -u piboost -f

# Verifica completa
sudo ./VERIFICA.sh

# Verifica giochi salvati
sudo ./VERIFICA-GIOCHI.sh

# Rimozione
sudo ./RIMUOVI.sh
```

## Dove vengono salvati i dati

```text
/opt/piboost/.env
/opt/piboost/data/
```

Non pubblicare mai questi file. `.gitignore` esclude già `.env`, dati runtime, backup, chiavi e log.

Tra i dati persistenti per utente ci sono:

- giochi selezionati e immagini;
- preferiti;
- impostazioni;
- stato di avvio automatico;
- ultimo boost;
- ore per gioco;
- numero di sessioni;
- date di inizio/fine;
- totali giornalieri;
- registro delle modifiche.

## Sviluppo locale

```bash
cd backend
cp .env.example .env
```

Genera una chiave:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Inseriscila in `backend/.env`, quindi:

```bash
npm install
npm run check
npm start
```

Apri:

```text
http://localhost:3000/steamboost/
```

## Controlli prima di pubblicare su GitHub

```bash
# Non devono essere presenti file .env reali
find . -name '.env' -o -name '*.pem' -o -name '*.key'

# Non devono essere presenti dati utente
find backend/data -maxdepth 1 -type f ! -name '.gitkeep'

# Verifica codice
cd backend
npm install
npm run check
npm audit --omit=dev
```

## Creare un nuovo repository GitHub

### Metodo dal sito GitHub

1. Crea un nuovo repository, per esempio `PiBoost-Raspberry`.
2. Lascialo vuoto: non aggiungere README, `.gitignore` o licenza dal sito.
3. Estrai questa cartella sul PC.
4. Apri PowerShell dentro la cartella ed esegui:

```powershell
git init
git branch -M main
git add -A
git commit -m "Prima release pubblica di PiBoost"
git remote add origin https://github.com/TUO-USERNAME/PiBoost-Raspberry.git
git push -u origin main
```

### Metodo con GitHub CLI

```powershell
gh auth login
git init
git branch -M main
git add -A
git commit -m "Prima release pubblica di PiBoost"
gh repo create PiBoost-Raspberry --public --source . --remote origin --push
```

È incluso anche lo script [`scripts/PUBBLICA-SU-GITHUB.ps1`](scripts/PUBBLICA-SU-GITHUB.ps1).

## Sicurezza

Leggi [`SECURITY.md`](SECURITY.md) prima di rendere pubblico il servizio.

Punti principali:

- non pubblicare `.env` o `/opt/piboost/data`;
- usa sempre HTTPS per il pannello owner;
- usa un dominio esatto in `OWNER_RP_ID`;
- limita le origini in `OWNER_ALLOWED_ORIGINS`;
- non esporre `/setup` o shell SSH senza protezione;
- aggiorna regolarmente Node.js, npm, Tailscale e PiBoost;
- evita di usare il servizio come piattaforma pubblica aperta senza rate limit e controllo degli utenti.

## Licenza

MIT. Vedi [`LICENSE`](LICENSE).
