# Caméras MJPEG et à image fixe

Amène dans Gladys les caméras qui parlent **simplement HTTP** : un
ESP32-CAM, une ancienne caméra IP, une webcam servie par motion, motionEye ou
mjpg-streamer. Deux types d'adresse fonctionnent : une URL d'**image JPEG
fixe** et un **flux MJPEG** (`multipart/x-mixed-replace`). Sans ffmpeg, sans
RTSP, rien dans le cloud : tout reste sur votre réseau local.

**Pour une caméra RTSP, utilisez plutôt l'intégration caméra RTSP intégrée à
Gladys** : celle-ci est la voie légère pour les caméras qui n'offrent que
HTTP. Sans lien avec aucun fabricant de caméras ; les marques citées
ci-dessous servent seulement à identifier des produits compatibles.

## Ce que vous obtenez

| Surface             | Contenu                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Appareil            | Un appareil caméra par adresse, avec son image dans le widget caméra du tableau de bord                                          |
| Vue en direct       | Une image fraîche à chaque demande de Gladys (vue en direct, « montre-moi la caméra », l'action « envoyer une image de caméra ») |
| Déclencheurs        | **Caméra hors ligne** (3 captures échouées de suite) et **Caméra de nouveau en ligne**                                           |
| Bouton des réglages | **Tester les caméras** : une image de chaque caméra, avec son type, sa résolution, sa taille et sa durée, ou l'erreur            |
| Badge de l'appareil | « Local » tant que la caméra répond, « Injoignable » une fois hors ligne, un point orange quand ses images doivent être réduites |

## Installation

Saisissez les adresses dans **Caméras**, séparées par des virgules. Chaque
adresse peut être suivie d'un **nom**, après une espace ou un `|` :

```
http://192.168.1.50:81/stream Jardin, http://192.168.1.20/cgi-bin/snapshot.cgi|Entrée
```

Ouvrez ensuite **Découverte** et ajoutez les caméras. Seules les caméras
ajoutées sont lues. Le bouton **Tester les caméras** vérifie chaque adresse.

Adresses courantes (vérifiez la documentation de votre caméra ; `<ip>` est
son adresse sur votre réseau) :

| Caméra                                   | Image fixe                                         | Flux                                  |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| ESP32-CAM (croquis « CameraWebServer »)  | `http://<ip>/capture`                              | `http://<ip>:81/stream`               |
| mjpg-streamer                            | `http://<ip>:8080/?action=snapshot`                | `http://<ip>:8080/?action=stream`     |
| motionEye                                | `http://<ip>:8765/picture/1/current/`              | `http://<ip>:8081/`                   |
| motion                                   | -                                                  | `http://<ip>:8081/`                   |
| Beaucoup de caméras IP (Dahua, Amcrest…) | `http://<ip>/cgi-bin/snapshot.cgi`                 | -                                     |
| Hikvision                                | `http://<ip>/ISAPI/Streaming/channels/101/picture` | -                                     |
| Axis                                     | `http://<ip>/axis-cgi/jpg/image.cgi`               | `http://<ip>/axis-cgi/mjpg/video.cgi` |
| Application Android « IP Webcam »        | `http://<ip>:8080/shot.jpg`                        | `http://<ip>:8080/video`              |

Une adresse d'image fixe est le choix le plus léger quand la caméra en
propose une. Un **ESP32-CAM ne sert son flux qu'à un client à la fois** :
tant qu'un navigateur regarde `:81/stream`, Gladys attend ; `/capture` évite
ce problème.

## Mots de passe

- Saisissez-les dans l'adresse : `http://utilisateur:motdepasse@192.168.1.20/…`.
  Un caractère spécial du mot de passe s'écrit encodé (`@` devient `%40`, une virgule `%2C`).
- Ou saisissez seulement le nom d'utilisateur dans l'adresse
  (`http://admin@192.168.1.20/…`) et le mot de passe dans **Mot de passe des
  caméras** : il reste masqué dans l'écran de configuration, contrairement à
  un mot de passe saisi dans l'adresse.
- Les authentifications Basic et **Digest** (MD5, SHA-256) sont prises en
  charge. Le mot de passe n'est jamais envoyé avant que la caméra le demande,
  jamais en clair à une caméra qui propose Digest, et seulement à cette
  caméra (jamais à une autre adresse vers laquelle elle redirige, sauf la
  même caméra en https).
- Une adresse qui porte un jeton dans sa requête (`?user=…&pwd=…`) fonctionne
  aussi : les journaux et les statuts ne montrent jamais d'adresse, seulement
  le nom et l'hôte de la caméra.
- Une caméra https avec un certificat auto-signé nécessite **Accepter les
  certificats auto-signés**.

## Images et rythme

- Chaque caméra ajoutée envoie une image à Gladys toutes les **10 secondes**
  par défaut (**Rafraîchissement de l'image**, 5 secondes au minimum :
  Gladys accepte 12 images par minute et par caméra ; 0 pour la demande
  uniquement). La vue en direct et les scènes reçoivent une image fraîche
  quel que soit ce réglage.
- Gladys accepte des images de **150 Ko** au plus. Une image plus grande est
  réduite (divisée par deux jusqu'à tenir) dans l'intégration, ce qui coûte
  du processeur : une telle caméra est alors rafraîchie toutes les 30
  secondes au plus, et le statut et le badge de l'appareil le signalent.
  **Choisissez plutôt une résolution plus basse sur la caméra** : VGA
  (640×480) ou SVGA (800×600) avec une qualité JPEG autour de 12 sur un
  ESP32-CAM.
- Une image est lue une seule fois à la fois par caméra, quel que soit le
  demandeur : l'image périodique, la vue en direct et le bouton de test la
  partagent.
- Un flux MJPEG n'est jamais regardé en continu : l'intégration prend sa
  première image, puis ferme la connexion.

## Scènes

- **Caméra hors ligne** : une caméra qui envoyait des images a échoué 3
  captures de suite. Variables : `name`, `error`, `failures`.
- **Caméra de nouveau en ligne** : la même caméra envoie de nouveau des
  images. Variables : `name`, `offline_minutes`.

Les deux ont un filtre **Caméra** facultatif (vide : toutes les caméras).
Ils vont par paires : une caméra déjà en panne au démarrage de l'intégration
n'annonce rien, et son retour n'est pas annoncé non plus. Une caméra hors
ligne est retentée chaque minute.

Pour envoyer une image dans un message, utilisez l'action « envoyer une
image de caméra » de Gladys avec l'une de ces caméras.

## Messages de statut et erreurs

| Message                                          | Signification                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `no image within 10 s`                           | La caméra ne répond pas (adresse, alimentation, un ESP32-CAM occupé par un navigateur)        |
| `the camera asks for a user name and password`   | Ajoutez-les à l'adresse (voir Mots de passe)                                                  |
| `user name or password refused`                  | Identifiants incorrects                                                                       |
| `not a JPEG image (text/html)`                   | L'adresse affiche une page web (page de connexion, accueil de la caméra) : corrigez le chemin |
| `certificate not trusted`                        | Une caméra https avec un certificat auto-signé : voir Mots de passe                           |
| `TLS handshake failed`                           | Une ancienne caméra https (TLS 1.0 ou 1.1) : utilisez son adresse http                        |
| `frame over 4 MB` ou `too big to downscale here` | Baissez la résolution de la caméra                                                            |

## Confidentialité

Rien ne quitte votre réseau et rien n'est écrit sur le disque : les images
vont uniquement à votre Gladys. La configuration garde les adresses ; les
appareils caméra ne montrent que l'hôte de chaque caméra.
