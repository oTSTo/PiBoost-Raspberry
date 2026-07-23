# Aggiornamento

```bash
cd /home/$USER/PiBoost-Raspberry
git pull
chmod +x *.sh backend/scripts/*.sh
sudo ./AGGIORNA.sh
```

L'aggiornamento crea un backup in `/opt/piboost-backups`, conserva `.env`, dati, token cifrati, giochi, ore, storico e passkey, quindi riavvia il servizio.

Controllo:

```bash
curl -s http://127.0.0.1:3000/api/health
sudo systemctl status piboost --no-pager
```
