// -----------------------------------------------------------------------------
// The texts shown to the user (feature names, connection status, action
// answers, command refusals), in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });

/** The text of a `{ en, fr }` in a language (French when missing). */
export const word = (text, language) => text?.[language] ?? text?.fr ?? String(text ?? '');

/** `{ en, fr }` parts -> one text, for the status and the action answers. */
export const join = (...parts) => ({
  en: parts.map((p) => p.en).join(' '),
  fr: parts.map((p) => p.fr).join(' '),
});

/** A duration, rounded: "45 s", "12 min", "3 h". */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export const FEATURE_NAMES = {
  state: (gate) => (gate ? both('Gate', 'Portail') : both('Garage door', 'Porte de garage')),
  open: (gate) =>
    gate ? both('Open the gate', 'Ouvrir le portail') : both('Open the door', 'Ouvrir la porte'),
  close: (gate) =>
    gate ? both('Close the gate', 'Fermer le portail') : both('Close the door', 'Fermer la porte'),
  temperature: both('Temperature', 'Température'),
  battery: both('Sensor battery', 'Pile du capteur'),
};

const DOOR_STATES = {
  opened: both('open', 'ouverte'),
  closed: both('closed', 'fermée'),
};

export const T = {
  noHost: both(
    'Type the IP address of the gateway in the configuration.',
    "Saisissez l'adresse IP de la passerelle dans la configuration.",
  ),
  invalidHost: (text) => both(`Not an address: ${text}.`, `Ce n'est pas une adresse : ${text}.`),
  hostCredentials: both(
    'The address holds a user name or a password: type only the IP address, and the credentials in their own fields.',
    "L'adresse contient un identifiant ou un mot de passe : saisissez seulement l'adresse IP, et les identifiants dans leurs champs.",
  ),
  missingCredentials: both(
    'Type the user name and the password of the gateway (those of its app or web page).',
    "Saisissez l'identifiant et le mot de passe de la passerelle (ceux de son application ou de sa page web).",
  ),
  invalidCredentials: both(
    'The user name or the password is too long or holds control characters: not used.',
    "L'identifiant ou le mot de passe est trop long ou contient des caractères de contrôle : non utilisés.",
  ),
  connecting: both('Connecting to the gateway…', 'Connexion à la passerelle…'),
  connected: (summary) => join(both('Connected:', 'Connecté :'), summary),
  summary: (name, model, doors) => {
    const label = [name, model ? `(${model})` : ''].filter(Boolean).join(' ') || 'ismartgate';
    const list = (lang) =>
      doors
        .map(
          (d) =>
            `${d.name}: ${d.status ? DOOR_STATES[d.status][lang] : lang === 'en' ? 'unknown' : 'inconnu'}`,
        )
        .join(', ');
    return both(`${label}. ${list('en')}.`, `${label}. ${list('fr')}.`);
  },
  noDoor: both(
    'No door is set up on the gateway (a door needs a name in its app).',
    "Aucune porte n'est configurée sur la passerelle (une porte doit avoir un nom dans son application).",
  ),
  opening: (allowed) =>
    allowed
      ? both('Opening allowed.', 'Ouverture autorisée.')
      : both('Opening disabled.', 'Ouverture désactivée.'),
  unreachable: (address, wait) =>
    both(
      `The gateway does not answer at ${address}; next try in ${wait}.`,
      `La passerelle ne répond pas à ${address} ; nouvel essai dans ${wait}.`,
    ),
  failing: (reason, wait) =>
    both(
      `The gateway gave an answer not understood (${reason}): check the type of gateway and the credentials; next try in ${wait}.`,
      `La passerelle a donné une réponse incomprise (${reason}) : vérifiez le type de passerelle et les identifiants ; nouvel essai dans ${wait}.`,
    ),
  authRefused: (wait) =>
    both(
      `The gateway refused the user name or the password: check them (next try in ${wait}, or at once after saving other ones).`,
      `La passerelle a refusé l'identifiant ou le mot de passe : vérifiez-les (nouvel essai dans ${wait}, ou dès l'enregistrement d'autres identifiants).`,
    ),
  paused: (wait) =>
    both(
      `The gateway asked to wait (HTTP 429 or 5xx): next read in ${wait}. Closing stays possible.`,
      `La passerelle a demandé d'attendre (HTTP 429 ou 5xx) : prochaine lecture dans ${wait}. La fermeture reste possible.`,
    ),
  noId: both(
    'The gateway did not give its remote access name (remoteaccess), its only id: its doors cannot be added.',
    "La passerelle n'a pas donné son nom d'accès à distance (remoteaccess), son seul identifiant : ses portes ne peuvent pas être ajoutées.",
  ),
  otherGateway: (names) =>
    both(
      `Another gateway answers at this address: ${names} no longer read (shown unreachable). Give the gateway a fixed address in your router, or delete these devices.`,
      `Une autre passerelle répond à cette adresse : ${names} n'est plus lu (affiché injoignable). Donnez une adresse fixe à la passerelle dans votre box, ou supprimez ces appareils.`,
    ),
  test: {
    recent: (wait) =>
      both(
        `Read less than one refresh interval ago (next read in ${wait}). Last result:`,
        `Lue il y a moins d'un intervalle de rafraîchissement (prochaine lecture dans ${wait}). Dernier résultat :`,
      ),
  },
};

/** The command refusals and errors (one language, the configured one). */
export const ERRORS = {
  readOnly: both('This feature cannot be controlled.', 'Cette fonctionnalité ne se commande pas.'),
  badValue: both('Invalid value: nothing sent.', "Valeur invalide : rien n'a été envoyé."),
  notConfigured: both(
    'The gateway is not configured (address, user name, password): nothing sent.',
    "La passerelle n'est pas configurée (adresse, identifiant, mot de passe) : rien n'a été envoyé.",
  ),
  unknownDevice: both(
    'This door belongs to a gateway that is no longer the one at the configured address: nothing sent.',
    "Cette porte appartient à une passerelle qui n'est plus celle de l'adresse configurée : rien n'a été envoyé.",
  ),
  openDisabled: both(
    'Opening is disabled in the configuration ("Allow opening"): nothing sent.',
    "L'ouverture est désactivée dans la configuration (« Autoriser l'ouverture ») : rien n'a été envoyé.",
  ),
  cancelled: both(
    'Cancelled by a close command: nothing sent.',
    "Annulée par une commande de fermeture : rien n'a été envoyé.",
  ),
  tooSlow: both(
    'The gateway did not answer in time: nothing sent.',
    "La passerelle n'a pas répondu à temps : rien n'a été envoyé.",
  ),
  blocked: both(
    'The gateway refused the user name or the password: nothing sent.',
    "La passerelle a refusé l'identifiant ou le mot de passe : rien n'a été envoyé.",
  ),
  paused: (wait) =>
    both(
      `The gateway asked to wait (HTTP 429 or 5xx), ${wait} more: nothing sent. Closing stays possible.`,
      `La passerelle a demandé d'attendre (HTTP 429 ou 5xx), encore ${wait} : rien n'a été envoyé. La fermeture reste possible.`,
    ),
  unknownState: (reason) =>
    both(
      `The state of the door could not be read just now (${reason}): nothing sent.`,
      `L'état de la porte n'a pas pu être lu à l'instant (${reason}) : rien n'a été envoyé.`,
    ),
  identity: both(
    'The gateway at the configured address could not be recognised as this one just now: nothing sent.',
    "La passerelle de l'adresse configurée n'a pas pu être reconnue comme celle-ci à l'instant : rien n'a été envoyé.",
  ),
  doorUnknown: both(
    'This door is no longer set up on the gateway: nothing sent.',
    "Cette porte n'est plus configurée sur la passerelle : rien n'a été envoyé.",
  ),
  noPermission: both(
    'The user of the configuration has no permission on this door: nothing sent.',
    "L'utilisateur de la configuration n'a pas de droit sur cette porte : rien n'a été envoyé.",
  ),
  unsupportedMode: both(
    'This output is not set as a garage door or a pulse in the gateway (on/off mode, or unknown): nothing sent.',
    "Cette sortie n'est pas réglée en porte de garage ni en impulsion dans la passerelle (mode marche/arrêt, ou inconnu) : rien n'a été envoyé.",
  ),
  statusUnknown: both(
    'The sensor of this door gives no state: a pulse could open it as well as close it, so nothing was sent.',
    "Le capteur de cette porte ne donne pas d'état : une impulsion pourrait l'ouvrir comme la fermer, rien n'a donc été envoyé.",
  ),
  justCommanded: both(
    'This door was commanded just now and is not seen moving yet: a second pulse would stop it or send it back, so nothing was sent. Try again in a few seconds.',
    "Cette porte vient d'être commandée et n'est pas encore vue bouger : une seconde impulsion l'arrêterait ou la renverrait, rien n'a donc été envoyé. Réessayez dans quelques secondes.",
  ),
  missingCode: both(
    'The gateway did not give the activation code of this door: nothing sent.',
    "La passerelle n'a pas donné le code d'activation de cette porte : rien n'a été envoyé.",
  ),
  notSent: (reason) => both(`Command not sent (${reason}).`, `Commande non envoyée (${reason}).`),
  refused: (reason) =>
    both(
      `The gateway refused the command (${reason}): no pulse.`,
      `La passerelle a refusé la commande (${reason}) : pas d'impulsion.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the door in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez la porte dans quelques secondes.`,
    ),
};
