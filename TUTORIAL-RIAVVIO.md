# Riavvio e boost automatico

Per abilitare l'avvio automatico del servizio:

```bash
sudo systemctl enable piboost
```

Nelle impostazioni dell'account attiva **Avvia automaticamente il boost al riavvio del Raspberry**. PiBoost può ripristinare l'ultimo boost soltanto se esiste ancora un refresh token Steam valido.

Test:

```bash
sudo reboot
```

Dopo il riavvio:

```bash
sudo systemctl status piboost --no-pager
sudo journalctl -u piboost -n 100 --no-pager
```
