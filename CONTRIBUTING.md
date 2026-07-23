# Contribuire

1. Crea un fork.
2. Crea un branch descrittivo.
3. Non aggiungere `.env`, dati Steam, token, backup o informazioni personali.
4. Esegui i controlli:

```bash
cd backend
npm ci
npm run check
npm audit --omit=dev
```

5. Descrivi chiaramente la modifica nella pull request.

Per modifiche al formato dei dati, documenta anche migrazione e rollback.
