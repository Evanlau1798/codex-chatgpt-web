# OpenCodex dans Codex Web GPT

Codex App, CLI et SDK conservent leur connexion à Codex Web GPT. Les modèles `chatgpt-web/*` utilisent le fonctionnement officiel de Codex Web GPT. Le transport des autres modèles passe par le moteur officiel OpenCodex, installé séparément et sans modification de ses sources.

Le tableau de bord complet est intégré à la fenêtre du lanceur Codex Web GPT : cliquez sur **OpenCodex** dans la barre latérale. Vous pouvez gérer les fournisseurs, modèles, comptes, combinaisons, journaux, réglages et mises à jour sans ouvrir une autre application. Le passage à ChatGPT ou aux paramètres du lanceur conserve la page et la session OpenCodex. Le bouton de rechargement permet de reprendre le tableau de bord après un redémarrage de son service. L'adresse locale http://127.0.0.1:10100 reste disponible en accès secondaire.

Cette vue utilise le même mécanisme natif Electron que le navigateur ChatGPT du lanceur. Elle possède une session séparée, reste dans un bac à sable et ne reçoit pas les outils natifs ni le preload privilégié du lanceur. Les liens externes d'authentification s'ouvrent dans le navigateur habituel.

Ajoutez les fournisseurs et leurs identifiants dans ce tableau de bord. Les modèles publiés par OpenCodex apparaissent dans le catalogue servi par Codex Web GPT. Les identifiants et niveaux de réflexion des modèles ChatGPT Web restent gérés par le code officiel de Codex Web GPT.

## Mise à jour

Utilisez le bouton de mise à jour du tableau de bord OpenCodex, ou le fichier `Mettre à jour OpenCodex.cmd`. Il n'est pas nécessaire de modifier le code d'OpenCodex à chaque mise à jour.

Le gestionnaire télécharge le paquet officiel npm dans un répertoire distinct, vérifie sa version et son intégrité, puis lance une instance isolée pour contrôler le démarrage, le catalogue Codex, les métadonnées d'outils/reflexion et le tableau de bord. Il conserve la configuration séparément des versions du programme.

Lorsqu'une tâche Codex est en cours, la mise à jour conserve la version active et la candidate préparée. Elle reste en cours et attend automatiquement jusqu'à 30 minutes que les tâches se terminent. Lorsque le service est libre, seul le moteur interne OpenCodex redémarre ; Codex Web GPT reste ouvert. Si l'attente expire, la candidate reste préparée : relancez la mise à jour après la fin des tâches. Une candidate incompatible est refusée. Une erreur après la bascule restaure le pointeur vers la version précédente et la configuration des fournisseurs sauvegardée.

L'intégration se réapplique aussi après une mise à jour Windows effectuée par le lanceur Codex Web GPT. Le gestionnaire récupère les sources officielles de la version installée, ajoute l'entrée et la vue OpenCodex selon les composants de navigation existants, puis vérifie et reconstruit l'interface. Les sources OpenCodex ne sont pas modifiées. Les configurations restent hors des répertoires de version.

Si une future version modifie les points d'intégration ou n'a pas de sources correspondantes accessibles, le gestionnaire refuse de remplacer le lanceur par une candidate non vérifiée et signale le problème. La mise à jour d'OpenCodex reste indépendante de cette reconstruction. Les réinstallations manuelles hors du lanceur doivent être suivies d'une réparation du raccordement avec `manager.cjs apply-launcher`.

## Propriété des configurations

OpenCodex fonctionne en mode `hub`, avec son intégration Codex directe désactivée. Codex Web GPT conserve la propriété de la connexion Codex et de son installation MCP. Le moteur OpenCodex reste dans un processus séparé pour isoler ses dépendances, son environnement réseau et ses caches.

La connexion des autres clients peut être configurée depuis les surfaces officielles OpenCodex. Les actions de gestion directe de l'intégration Codex sont réservées à Codex Web GPT ; les pages fournisseurs, comptes et modèles restent disponibles. Le proxy du tableau de bord relaie aussi les flux HTTP et WebSocket des surfaces OpenCodex.

## Limites de validation

Les échanges avec des fournisseurs externes ont été vérifiés avec un fournisseur simulé, sans consommer leurs quotas. Un fournisseur réel nécessite vos identifiants et conserve ses propres restrictions. Les garanties de compatibilité concernent les contrats vérifiés ; aucune intégration ne peut garantir par avance une future version qui supprimerait ses API. Les contrôles préviennent l'application silencieuse d'une telle version.

Cette intégration n'établit pas une nouvelle garantie universelle d'exécution d'outils pour Instant et ne corrige pas, à elle seule, les limitations préexistantes du contrat Codex Native2.
