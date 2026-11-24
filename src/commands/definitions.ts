import { SlashCommandBuilder } from 'discord.js';
import type { Library } from '../plex/client.js';

/** The slash commands, in French. Library choices come from Plex at start. */
export function commandDefinitions(libraries: readonly Library[]) {
  const play = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Joue une piste, un album ou une playlist de Plex')
    .addStringOption((o) =>
      o
        .setName('recherche')
        .setDescription('Titre, album ou playlist : choisis dans la liste')
        .setRequired(true)
        .setAutocomplete(true)
        .setMaxLength(100),
    )
    .addStringOption((o) =>
      o
        .setName('bibliotheque')
        .setDescription('Chercher dans une seule bibliothèque')
        .addChoices(...libraries.slice(0, 25).map((l) => ({ name: l.title, value: String(l.id) }))),
    )
    .addBooleanOption((o) => o.setName('ensuite').setDescription('Jouer juste après le titre en cours'))
    .addBooleanOption((o) => o.setName('melanger').setDescription('Mélanger l’album ou la playlist ajoutée'));

  return [
    play,
    new SlashCommandBuilder().setName('file').setDescription('Affiche la file d’attente'),
    new SlashCommandBuilder()
      .setName('panneau')
      .setDescription('Publie le panneau jukebox : chercher, playlists, au hasard, sans taper de commande'),
    new SlashCommandBuilder()
      .setName('encours')
      .setDescription('Remet la carte « en cours » en bas du salon'),
    new SlashCommandBuilder()
      .setName('passer')
      .setDescription('Passe au titre suivant, ou jusqu’à une position de la file')
      .addIntegerOption((o) => o.setName('jusqua').setDescription('Position dans la file').setMinValue(1)),
    new SlashCommandBuilder().setName('precedent').setDescription('Revient au titre précédent'),
    new SlashCommandBuilder().setName('pause').setDescription('Met en pause ou reprend la lecture'),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Arrête la musique, vide la file et quitte le vocal'),
    new SlashCommandBuilder().setName('melanger').setDescription('Mélange les titres à suivre'),
    new SlashCommandBuilder()
      .setName('boucle')
      .setDescription('Répète le titre ou la file')
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('Ce qui se répète')
          .setRequired(true)
          .addChoices(
            { name: 'Désactivée', value: 'off' },
            { name: 'Le titre en cours', value: 'track' },
            { name: 'Toute la file', value: 'queue' },
          ),
      ),
    new SlashCommandBuilder()
      .setName('avancer')
      .setDescription('Va à un moment du titre')
      .addStringOption((o) =>
        o
          .setName('moment')
          .setDescription('Par exemple 1:30, ou 90 (secondes)')
          .setRequired(true)
          .setMaxLength(8),
      ),
    new SlashCommandBuilder()
      .setName('volume')
      .setDescription('Règle le volume du bot')
      .addIntegerOption((o) =>
        o.setName('niveau').setDescription('De 0 à 150 %').setRequired(true).setMinValue(0).setMaxValue(150),
      ),
    new SlashCommandBuilder()
      .setName('retirer')
      .setDescription('Retire un titre de la file')
      .addIntegerOption((o) =>
        o.setName('position').setDescription('Position dans la file').setRequired(true).setMinValue(1),
      ),
    new SlashCommandBuilder()
      .setName('deplacer')
      .setDescription('Déplace un titre dans la file')
      .addIntegerOption((o) =>
        o.setName('de').setDescription('Position actuelle').setRequired(true).setMinValue(1),
      )
      .addIntegerOption((o) =>
        o.setName('vers').setDescription('Nouvelle position').setRequired(true).setMinValue(1),
      ),
    new SlashCommandBuilder()
      .setName('vider')
      .setDescription('Vide les titres à suivre (le titre en cours continue)'),
  ].map((c) => c.toJSON());
}
