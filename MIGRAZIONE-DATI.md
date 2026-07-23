# Migrazione dati

`AGGIORNA.sh` conserva automaticamente:

```text
/opt/piboost/.env
/opt/piboost/data/
```

Prima di sostituire i file crea:

```text
/opt/piboost-backups/piboost-pre-VERSION-DATA-ORA.tar.gz
```

La versione 4.1.0 mantiene compatibilità con gli archivi della serie 4.0. I giochi selezionati vengono recuperati anche dall'ultimo boost e dallo storico quando la lista principale è vuota.
