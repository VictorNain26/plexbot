# plexbot

Bot Discord qui joue la musique d'un serveur Plex dans un salon vocal : pistes, albums et
playlists, choix de la bibliothèque, file d'attente partagée et carte « en cours de lecture ».

## Commandes

| Commande                                              | Effet                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `/play recherche [bibliotheque] [ensuite] [melanger]` | Autocomplétion des pistes 🎵, albums 💿 et playlists 📜, avec leur bibliothèque. |
| `/file`                                               | La file, page par page (numéros utilisés par `/retirer` et `/deplacer`).         |
| `/passer [jusqua]`, `/precedent`, `/pause`, `/stop`   | Lecture.                                                                         |
| `/melanger`, `/boucle`, `/avancer`, `/volume`         | Réglages.                                                                        |
| `/retirer`, `/deplacer`, `/vider`                     | Édition de la file.                                                              |
| `/encours`                                            | Remet la carte en bas du salon.                                                  |

Les boutons de la carte font la même chose. Il faut être dans le salon vocal du bot pour le piloter.

## Fonctionnement

- discord.js 14 et @discordjs/voice 0.19 (voix chiffrée DAVE, obligatoire depuis mars 2026).
- Plex : API HTTP (`/hubs/search`, `/playlists`, `/library/metadata`), token en en-tête.
- Audio : ffmpeg lit le fichier original sur Plex, applique le gain de normalisation que Plex a
  mesuré, et sort du PCM 48 kHz qu'Opus encode. Volume réglable en direct.
- La file est sauvegardée (SQLite, `node:sqlite`) : un redémarrage reprend où il en était.
- Lecture signalée à Plex (« Lecture en cours », historique au-delà de 90 %).

## Développer

```sh
npm ci
npm run check      # format, lint, types, tests
npm run mutation   # mutation testing (Stryker), seuil 80 %
```

## Déployer (victorserv)

Le serveur ne construit rien : la CI publie `ghcr.io/victornain26/plexbot:sha-<commit>` avec une
attestation de provenance, et `deploy/deploy.sh` (lancé par `plexbot-deploy.timer`, rôle
`plexbot` de victorserv) l'installe une fois vérifiée. À côté de `compose.yaml`, hors git :

- `.env` : `DISCORD_GUILD_ID=<id du serveur Discord>` ;
- `secrets/discord_token` et `secrets/plex_token` (mode 600) ;
- `data/` : la base SQLite.

Le bot n'a besoin d'aucun intent privilégié. Permissions d'invitation : voir les salons, envoyer
des messages, joindre des fichiers, se connecter, parler.
