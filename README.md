# T&E Demand & Resource Manager

Application web (interface en **anglais**) de gestion des demandes de travaux et des ressources pour le périmètre **Tooling & Equipment (T&E)** :
saisie, triage, approbation, dispatch, planification de capacité (en heures) et deux vues Gantt (**par ressource** et **par demande**).

Elle implémente le cahier des charges décrit dans [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) (conçu à l'origine pour Power Apps + SharePoint Lists) sous la forme d'une application web autonome, déployable sur un VPS.

- **Stack** : Node.js 22.13+ (24 en Docker) · Express · SQLite intégré (`node:sqlite`, aucune dépendance native) · front en JavaScript natif, **sans étape de build**.
- **Déploiement** : Docker Compose (app + Caddy avec HTTPS Let's Encrypt automatique).
- **Données** : un dossier `data/` (base SQLite, pièces jointes, sauvegardes) — c'est tout ce qu'il faut sauvegarder.

## Fonctionnalités

| Domaine | Contenu |
|---|---|
| Demandes | Champs obligatoires (titre, description, site, équipement, catégorie, priorité, échéance, demandeur auto), pièces jointes, commentaires, historique d'audit complet, filtres (site, catégorie, priorité, statut, équipe, assigné, dates), export CSV |
| Workflow | Submitted → Triage → Pending Approval → Approved → Scheduled → In Progress → Completed → Closed (+ On Hold, Rejected, Cancelled), approbation à un niveau par le Dispatch Manager |
| Ressources | Capacité hebdomadaire en heures, équipe, site, compétences, indisponibilités (plages de jours entiers) |
| Affectations | Dates + heures planifiées ; refus si indisponibilité ; alerte de surcharge avec confirmation ; passage automatique en *Scheduled* |
| Gantt | Par ressource (barres, hachures d'indisponibilité, charge/capacité par période) et par demande (barres par affectation, losange d'échéance) ; zoom Jour / Semaine / Mois |
| Notifications | In-app (création, changement de statut, approbation, affectation, échéance proche/dépassée) + webhook optionnel (Teams, Slack, n8n, Power Automate) |
| Sécurité | Rôles Requestor / Technician / Dispatch Manager / Admin, contrôle d'accès côté serveur, cookies HttpOnly, mots de passe bcrypt, limitation des tentatives de connexion |

## Démarrage local (test)

Prérequis : Node.js ≥ 22.13.

```bash
npm install
SEED_DEMO=true ADMIN_PASSWORD='ChangeMe!2026' npm start
```

Puis ouvrir <http://localhost:3000>. Comptes de démo (mot de passe `ChangeMe!2026`) : `manager@example.com`, `requestor@example.com`, `tech1@example.com`…, et `admin@example.com` (mot de passe = `ADMIN_PASSWORD`).

Tests automatisés : `npm test`.

## 1. Publier sur votre GitHub

Depuis le dossier du projet :

```bash
git init -b main
git add .
git commit -m "Initial commit: T&E Demand & Resource Manager"
git remote add origin https://github.com/<VOTRE_USER>/<VOTRE_REPO>.git
git push -u origin main
```

Le fichier `.gitignore` exclut `.env` et `data/` : aucun secret ni donnée n'est publié.

## 2. Installer sur le VPS Hostinger (une commande)

Prérequis : VPS Ubuntu/Debian avec accès root (SSH). Si vous avez un nom de domaine, créez d'abord un enregistrement DNS **A** vers l'IP du VPS.

```bash
curl -fsSL https://raw.githubusercontent.com/<VOTRE_USER>/<VOTRE_REPO>/main/deploy/install.sh | \
  sudo REPO_URL=https://github.com/<VOTRE_USER>/<VOTRE_REPO>.git DOMAIN=app.exemple.com bash
```

- `DOMAIN=app.exemple.com` → HTTPS automatique. Sans `DOMAIN` → HTTP simple sur l'IP du VPS (port 80).
- Le script installe Docker si besoin, clone le dépôt dans `/opt/te-app`, génère `.env` avec un mot de passe admin et un secret aléatoires (**affichés une seule fois** : notez-les), puis lance `docker compose up -d --build`.
- Dépôt **privé** : utilisez une URL avec jeton (`https://<TOKEN>@github.com/...`) ou une *deploy key* SSH (`REPO_URL=git@github.com:...`).
- Ports 80/443 déjà utilisés ? Renseignez `HTTP_PORT` / `HTTPS_PORT` dans `/opt/te-app/.env`.

Première connexion : `admin@example.com` (ou `ADMIN_EMAIL` du `.env`) → **changer le mot de passe** (bouton *Password*), puis dans **Admin** : renommer sites / équipes / catégories, créer les utilisateurs, puis dans **Resources** : créer les ressources et leurs capacités.

## 3. Mises à jour

Sur le VPS :

```bash
bash /opt/te-app/deploy/update.sh
```

(sauvegarde, `git pull`, rebuild, redémarrage). **Automatique** : le workflow `.github/workflows/deploy.yml` se déclenche après un CI vert sur `main`. Ajoutez dans *GitHub → Settings → Secrets and variables → Actions* : `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (clé privée sans passphrase dont la clé publique est dans `~/.ssh/authorized_keys` du VPS), et optionnellement `VPS_PORT`, `VPS_APP_DIR`.

## 4. Sauvegarde & exploitation

```bash
bash /opt/te-app/deploy/backup.sh            # base + pièces jointes -> /opt/te-app/backups (14 dernières)
docker compose -f /opt/te-app/docker-compose.yml logs -f app
docker compose -f /opt/te-app/docker-compose.yml ps
```

Cron quotidien conseillé : `30 2 * * * bash /opt/te-app/deploy/backup.sh >> /var/log/te-backup.log 2>&1`.
Pensez à copier régulièrement `backups/` hors du VPS (snapshots Hostinger ou `rsync`).

## Configuration (`.env`)

Voir [`.env.example`](.env.example). Points clés : `DOMAIN`, `ADMIN_EMAIL`/`ADMIN_PASSWORD` (création du premier admin uniquement), `JWT_SECRET`, `NOTIFY_WEBHOOK_URL`, `MAX_UPLOAD_MB`. **Ne jamais activer `SEED_DEMO=true` en production.**

## Structure du dépôt

```
server/            API Express, base SQLite, workflow, calcul de capacité, notifications
  routes/          requests · resources (+Gantt) · misc (auth, admin, dashboard, CSV)
public/            Interface (index.html, app.js, gantt.js, style.css) — aucun build
deploy/            install.sh, update.sh, backup.sh, Caddyfile
.github/workflows/ ci.yml (tests + build Docker), deploy.yml (déploiement SSH)
docs/              SPECIFICATION.md (exigences complètes, modèle de données, critères d'acceptation)
test/              Tests d'intégration (node --test)
```

## Limites connues / pistes V1-V2

- Authentification locale (e-mail + mot de passe). Une intégration Azure AD / Microsoft Entra ID (OIDC) est la suite logique si les utilisateurs doivent se connecter avec leur compte Microsoft.
- Notifications par e-mail non incluses (webhook disponible) ; approbation supplémentaire si *Safety impact = High* prévue en V2.
- Gantt en lecture (cliquer une barre ouvre la demande) ; le glisser-déposer des barres est prévu en V1.
