# ismartgate pour Gladys Assistant

Cette intégration affiche dans Gladys les portes de garage et portails pilotés
par une passerelle **ismartgate** (PRO, LITE, Mini) ou **GogoGate2**, et
ajoute des boutons pour les ouvrir et les fermer, par l'API locale de la
passerelle, sur votre réseau, sans son cloud.

**Jamais testé avec un vrai appareil** : l'intégration suit la bibliothèque
ismartgate (celle de l'intégration Home Assistant « Gogogate2 and
ismartgate »), mais personne ne l'a encore essayée sur une passerelle réelle.
Cette API locale n'est pas documentée par le fabricant. Vos retours sont les
bienvenus.

Intégration non officielle, sans lien avec ismartgate.

## Dans Gladys

Un appareil par porte configurée sur la passerelle (une porte qui a un nom
dans son application) :

| Fonctionnalité           | Détail                                                                   |
| ------------------------ | ------------------------------------------------------------------------ |
| Porte de garage, Portail | capteur d'ouverture, lecture seule (ouverte / fermée)                    |
| Ouvrir, Fermer           | boutons (seulement pour une sortie en mode porte de garage ou impulsion) |
| Température              | capteur sans fil seulement                                               |
| Pile du capteur          | en %, capteur sans fil seulement                                         |

## Installation

1. Donnez à la passerelle une adresse IP fixe dans votre box.
2. Dans l'application ismartgate, créez de préférence un utilisateur pour
   Gladys, avec seulement les portes qu'il peut commander.
3. Dans Gladys, installez l'intégration ismartgate depuis le store, choisissez
   la famille (ismartgate ou GogoGate2), saisissez l'adresse IP, l'identifiant
   et le mot de passe.
4. Ajoutez les portes depuis l'onglet Découverte.

Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché, envoyé
seulement à votre passerelle. L'API locale le transporte brouillé (AES) dans
l'adresse de la requête, en HTTP : sur une ismartgate la clé est tirée de
l'identifiant et du mot de passe, mais sur une **GogoGate2 la clé est la même
pour toutes les passerelles et publique** : quiconque capte le trafic de votre
réseau local peut lire l'identifiant et le mot de passe. Utilisez un
utilisateur dédié, avec un mot de passe que vous n'utilisez nulle part
ailleurs.

## Sécurité des commandes

La passerelle ne connaît qu'une commande : **une impulsion** sur le relais de
la porte, la même pour ouvrir et pour fermer, comme le bouton d'une
télécommande. Une impulsion pendant que la porte bouge peut l'arrêter ou la
renvoyer dans l'autre sens. Donc :

- une porte n'est jamais un interrupteur : un « éteins tout » d'un assistant
  vocal ou d'une scène ne peut pas l'atteindre ;
- **l'ouverture est désactivée par défaut** : activez « Autoriser
  l'ouverture » pour que le tableau de bord, les scènes et les assistants
  vocaux puissent ouvrir. L'autorisation est vérifiée à l'arrivée de la
  commande, après la relecture et juste avant l'envoi ;
- chaque commande relit la passerelle juste avant d'agir : la passerelle doit
  être la même (son identifiant), la porte configurée, en mode porte de garage
  ou impulsion, avec un état connu. « Ouvrir » n'envoie une impulsion que sur
  une porte lue fermée, « Fermer » que sur une porte lue ouverte ; dans
  l'état voulu, rien n'est envoyé ; sans état (capteur absent ou en défaut),
  rien n'est envoyé ;
- **fermer est toujours permis** : sans l'autorisation, même pendant une
  pause demandée par la passerelle ou après des identifiants refusés (un seul
  essai), et une fermeture annule aussitôt une ouverture de la même porte qui
  n'est pas encore partie ;
- une impulsion à la fois par porte, et après chaque impulsion aucune autre
  sur cette porte tant qu'elle n'est pas lue dans l'autre état, ou que le
  « temps de course » (30 s par défaut) plus 5 s n'est pas écoulé ;
- une commande qui ne peut pas partir en 3,5 secondes est refusée sans être
  envoyée ; une impulsion partie sans réponse est annoncée « envoyée, sans
  confirmation », puis la porte est relue.

**Limite** : la passerelle ne dit pas si une porte est en train de se fermer
(le capteur reste « ouverte » jusqu'à la fin de la course). Si quelqu'un vient
de lancer la fermeture avec une télécommande et qu'une fermeture part de
Gladys au même moment, l'impulsion peut arrêter la porte ou la renvoyer vers
l'ouverture, comme un second appui sur la télécommande. Gladys ne le fait
jamais elle-même deux fois de suite (la garde ci-dessus).

Il n'y a pas de bouton « Arrêter » : la passerelle n'a pas de commande d'arrêt.

## Pannes

- Identifiants refusés : la passerelle n'est plus interrogée, puis à nouveau
  après 15 min, 1 h, 6 h et toutes les 24 h, même après un redémarrage ;
  enregistrer d'autres identifiants réessaie aussitôt, « Tester la
  connexion » dès que l'intervalle de rafraîchissement est écoulé.
- Une passerelle qui demande d'attendre (HTTP 429 ou 5xx) est mise en pause
  d'une minute à six heures, même après un redémarrage : ni relevé ni
  ouverture ; fermer reste possible.
- Une passerelle qui ne répond pas est relue après 30 s, 1, 2 puis 5 min,
  jamais plus vite que l'intervalle de rafraîchissement. « Tester la
  connexion », une reconnexion de Gladys ou un redémarrage ne relisent jamais
  plus vite que l'intervalle.
- Si une autre passerelle répond à l'adresse (bail DHCP), ses portes
  apparaissent dans l'onglet Découverte et les anciennes sont affichées
  injoignables.

## Limites

- Pas de recherche automatique sur le réseau : saisissez l'adresse IP.
- Pas de caméra, pas de sorties en mode marche/arrêt (affichées en lecture
  seule), pas d'accès par le cloud ismartgate.
