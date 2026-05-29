// filterprotect.js
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionsBitField,
  Events
} = require("discord.js");
const fs = require("fs");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// ---------------- CONFIG STORAGE ----------------
let config = { guilds: {} };
const CONFIG_FILE = "./filterprotect_config.json";
if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    config = { guilds: {} };
  }
}
function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
function ensureGuildConfig(guildId) {
  if (!config.guilds[guildId]) {
    config.guilds[guildId] = {
      adminRole: null,
      harshness: 1,
      modules: {
        textFilter: true,
        spamFilter: true,
        linkFilter: true,
        inviteFilter: true,
        gamblingFilter: true,
        drugsFilter: true,
        violenceFilter: true,
        selfharmFilter: true,
        scamFilter: true,
        groomingFilter: true,
        profanityFilter: true
      },
      strikes: {},
      logsChannelId: null
    };
  }
  return config.guilds[guildId];
}

// ---------------- LOGGING ----------------
async function logEvent(guild, guildConfig, title, description, fields = []) {
  try {
    let channel = guildConfig.logsChannelId
      ? guild.channels.cache.get(guildConfig.logsChannelId)
      : null;

    if (!channel) {
      channel = guild.channels.cache.find(
        c => c.name === "filterprotect-logs" && c.isTextBased()
      );
      if (!channel) {
        channel = await guild.channels.create({
          name: "filterprotect-logs",
          type: 0
        });
      }
      guildConfig.logsChannelId = channel.id;
      saveConfig();
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor("#ff5555")
      .setTimestamp();

    if (fields.length) embed.addFields(fields);

    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error("Log error:", e);
  }
}

// ---------------- PERMISSIONS ----------------
function canManage(interaction, guildConfig) {
  if (interaction.user.id === interaction.guild.ownerId) return true;
  if (!guildConfig.adminRole) return false;
  return interaction.member.roles.cache.has(guildConfig.adminRole);
}

// ---------------- WORD LISTS ----------------
// NSFW / sexual
const NSFW_WORDS = [
  "sex","porn","porno","pornhub","nude","nudes","naked","blowjob","bj","pussy","cock","dick","dildo",
  "anal","deepthroat","hentai","cum","cumshot","orgasm","tits","boobs","milf","fetish","bdsm","bondage",
  "horny","nsfw","onlyfans","sexting","strip","stripper","camgirl","camshow","jerk","jerking","masturbate",
  "masturbation","handjob","69","threesome","foursome","gangbang","creampie","facial","rimjob"
];

// profanity / insults
const PROFANITY = [
  "fuck","shit","bitch","whore","slut","bastard","cunt","dickhead","motherfucker","asshole","prick",
  "twat","wanker","bollocks","piss off","go fuck yourself","son of a bitch"
];

// violence / gore
const VIOLENCE = [
  "kill","murder","stab","shoot","blood","gore","die","choke","strangled","decapitate","torture",
  "execute","assault","beat you","i will kill you","i will hurt you","i will stab you","i will shoot you"
];

// self-harm / suicide
const SELF_HARM = [
  "kys","kill yourself","go die","end yourself","suicide","self harm","cut myself","i want to die",
  "i want to kill myself","i want to end it","i hate my life"
];

// drugs
const DRUGS = [
  "weed","cannabis","marijuana","coke","cocaine","heroin","meth","methamphetamine","pills","xanax",
  "ketamine","lsd","acid","molly","ecstasy","crack","opioids","opium","lean","codeine"
];

// gambling
const GAMBLING = [
  "casino","slots","betting","roulette","blackjack","jackpot","poker","sportsbook","bet","wager",
  "stake","gamble","slot machine"
];

// scams / phishing
const SCAMS = [
  "free nitro","nitro generator","click here","verify your account","steam gift","crypto giveaway",
  "airdrop","investment bot","double your money","free robux","free vbucks","claim reward",
  "login to claim","you won","winner selected","congratulations click"
];

// grooming / predatory
const GROOMING = [
  "send pics","send nudes","dont tell anyone","dont tell your parents","how old are you really",
  "are you alone","show me","private chat","secret chat","i can teach you","trust me only",
  "come meet me","dont tell your friends"
];

// bypass variants
const LEET_VARIANTS = [
  "f4ck","f@ck","f*ck","f!ck",
  "sh1t","sh!t","5hit",
  "b1tch","b!tch","b*tch",
  "c0ck","c0c","c0q",
  "d1ck","d!ck","d!c",
  "wh0re","wh0r3","w#ore",
  "5lut","slvt","sl*t"
];

const BROKEN_WORDS = [
  "f u c k","f.u.c.k","f-u-c-k","f u-c k",
  "s h i t","s.h.i.t","s-h-i-t",
  "b i t c h","b.i.t.c.h","b-i-t-c-h",
  "c o c k","c.o.c.k","c-o-c-k"
];

const SYMBOL_VARIANTS = [
  "f@ck","f*ck","f#ck","f$ck",
  "sh!t","sh*t","sh#t",
  "b!tch","b*tch","b#tch",
  "c*ck","c@ck","c#ck"
];

const SHORTENED = [
  "fk","fck","fkc",
  "sht","sh1t","sh!t",
  "btch","b!tch","b1tch",
  "dck","d!ck","d1ck",
  "cck","c0ck","c0c"
];

const TEXT_FILTER = [
  ...NSFW_WORDS,
  ...PROFANITY,
  ...VIOLENCE,
  ...SELF_HARM,
  ...DRUGS,
  ...GAMBLING,
  ...SCAMS,
  ...GROOMING,
  ...LEET_VARIANTS,
  ...BROKEN_WORDS,
  ...SYMBOL_VARIANTS,
  ...SHORTENED
];

// spam map
const spamMap = {};

// ---------------- GUILD JOIN ----------------
client.on(Events.GuildCreate, async (guild) => {
  ensureGuildConfig(guild.id);
  saveConfig();

  const channel = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased());
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("👋 Welcome to FilterProtect")
    .setDescription(
      "Thanks for adding **FilterProtect**.\n\n" +
      "Use `/filterprotect panel` to configure the bot.\n\n" +
      "Only the **server owner** or the chosen **admin role** can manage settings."
    )
    .setColor("#5865F2");

  await channel.send({ embeds: [embed] });
});

// ---------------- SLASH COMMANDS ----------------
client.on("ready", async () => {
  const commands = [
    {
      name: "filterprotect",
      description: "FilterProtect controls",
      options: [
        {
          name: "panel",
          description: "Open the FilterProtect control panel",
          type: 1
        }
      ]
    }
  ];

  await client.application.commands.set(commands);
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------------- INTERACTIONS ----------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inGuild()) return;
  const guildId = interaction.guild.id;
  const guildConfig = ensureGuildConfig(guildId);

  // slash command
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "filterprotect" && interaction.options.getSubcommand() === "panel") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({
          content: "❌ You do not have permission to manage FilterProtect.",
          ephemeral: true
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("🛡️ FilterProtect Control Panel")
        .setDescription(
          "Use the buttons below to manage FilterProtect.\n\n" +
          "**Page 1:** Admin + Logs\n" +
          "**Page 2:** Modules\n" +
          "**Page 3:** Harshness\n" +
          "**Page 4:** Finish / Save"
        )
        .setColor("#5865F2");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("fp_page1").setLabel("Page 1").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_page2").setLabel("Page 2").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_page3").setLabel("Page 3").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_page4").setLabel("Finish").setStyle(ButtonStyle.Success)
      );

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
  }

  // buttons
  if (interaction.isButton()) {
    const id = interaction.customId;

    // page 1: admin + logs
    if (id === "fp_page1") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle("⚙️ Setup — Page 1 (Admin & Logs)")
        .setDescription("Select an admin role and configure the logs channel.")
        .setColor("#5865F2")
        .addFields(
          { name: "Admin Role", value: guildConfig.adminRole ? `<@&${guildConfig.adminRole}>` : "Not set", inline: true },
          { name: "Logs Channel", value: guildConfig.logsChannelId ? `<#${guildConfig.logsChannelId}>` : "Auto / Not set", inline: true }
        );

      const roles = interaction.guild.roles.cache
        .filter(r => r.name !== "@everyone")
        .map(r => ({ label: r.name.slice(0, 100), value: r.id }));

      const roleMenu = new StringSelectMenuBuilder()
        .setCustomId("fp_admin_role_select")
        .setPlaceholder("Select admin role")
        .addOptions(roles.slice(0, 25));

      const logsButton = new ButtonBuilder()
        .setCustomId("fp_set_logs_here")
        .setLabel("Set this channel as logs")
        .setStyle(ButtonStyle.Primary);

      const row1 = new ActionRowBuilder().addComponents(roleMenu);
      const row2 = new ActionRowBuilder().addComponents(logsButton);

      return interaction.update({ embeds: [embed], components: [row1, row2] });
    }

    // page 2: modules
    if (id === "fp_page2") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }

      const m = guildConfig.modules;
      const embed = new EmbedBuilder()
        .setTitle("⚙️ Setup — Page 2 (Modules)")
        .setDescription("Toggle modules on or off.")
        .setColor("#5865F2")
        .addFields(
          { name: "Text Filter", value: m.textFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Spam Filter", value: m.spamFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Link Filter", value: m.linkFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Invite Filter", value: m.inviteFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Gambling Filter", value: m.gamblingFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Drugs Filter", value: m.drugsFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Violence Filter", value: m.violenceFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Self‑harm Filter", value: m.selfharmFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Scam Filter", value: m.scamFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Grooming Filter", value: m.groomingFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Profanity Filter", value: m.profanityFilter ? "✅ ON" : "❌ OFF", inline: true }
        );

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("fp_toggle_text").setLabel("Text").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("fp_toggle_spam").setLabel("Spam").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("fp_toggle_links").setLabel("Links").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("fp_toggle_invites").setLabel("Invites").setStyle(ButtonStyle.Primary)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("fp_toggle_gambling").setLabel("Gambling").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_toggle_drugs").setLabel("Drugs").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_toggle_violence").setLabel("Violence").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_toggle_selfharm").setLabel("Self‑harm").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_toggle_scams").setLabel("Scams").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_toggle_grooming").setLabel("Grooming").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_toggle_profanity").setLabel("Profanity").setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row1, row2] });
    }

    // page 3: harshness
    if (id === "fp_page3") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle("⚙️ Setup — Page 3 (Harshness)")
        .setDescription(
          "Choose how strict FilterProtect should be:\n\n" +
          "**1 Soft** — delete + warn\n" +
          "**2 Medium** — delete + warn + strike\n" +
          "**3 Hard** — delete + timeout\n" +
          "**4 Extreme** — delete + timeout + auto‑kick after 3 strikes"
        )
        .setColor("#5865F2")
        .addFields({ name: "Current", value: guildConfig.harshness.toString(), inline: true });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("fp_h1").setLabel("1").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_h2").setLabel("2").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_h3").setLabel("3").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_h4").setLabel("4").setStyle(ButtonStyle.Danger)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // page 4: finish
    if (id === "fp_page4") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }

      saveConfig();

      const embed = new EmbedBuilder()
        .setTitle("✅ Setup Complete")
        .setDescription("FilterProtect is now active with your chosen settings.")
        .setColor("#57F287");

      return interaction.update({ embeds: [embed], components: [] });
    }

    // set logs here
    if (id === "fp_set_logs_here") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }
      guildConfig.logsChannelId = interaction.channel.id;
      saveConfig();
      return interaction.reply({ content: `✅ Logs channel set to <#${interaction.channel.id}>`, ephemeral: true });
    }

    // module toggles
    const toggleMap = {
      fp_toggle_text: "textFilter",
      fp_toggle_spam: "spamFilter",
      fp_toggle_links: "linkFilter",
      fp_toggle_invites: "inviteFilter",
      fp_toggle_gambling: "gamblingFilter",
      fp_toggle_drugs: "drugsFilter",
      fp_toggle_violence: "violenceFilter",
      fp_toggle_selfharm: "selfharmFilter",
      fp_toggle_scams: "scamFilter",
      fp_toggle_grooming: "groomingFilter",
      fp_toggle_profanity: "profanityFilter"
    };

    if (toggleMap[id]) {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }
      const key = toggleMap[id];
      guildConfig.modules[key] = !guildConfig.modules[key];
      saveConfig();
      return interaction.reply({
        content: `🔧 **${key}** is now **${guildConfig.modules[key] ? "ENABLED" : "DISABLED"}**`,
        ephemeral: true
      });
    }

    // harshness buttons
    if (id.startsWith("fp_h")) {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }
      const level = Number(id.replace("fp_h", ""));
      guildConfig.harshness = level;
      saveConfig();
      return interaction.reply({ content: `⚠️ Harshness set to **${level}**`, ephemeral: true });
    }
  }

  // select menus
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "fp_admin_role_select") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }
      const roleId = interaction.values[0];
      guildConfig.adminRole = roleId;
      saveConfig();
      return interaction.reply({ content: `✅ Admin role set to <@&${roleId}>`, ephemeral: true });
    }
  }
});

// ---------------- MESSAGE FILTERING ----------------
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  const guildId = message.guild.id;
  const guildConfig = ensureGuildConfig(guildId);
  const modules = guildConfig.modules;

  const raw = message.content || "";
  const lower = raw.toLowerCase();
  const normalized = lower.replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");

  async function punish(reason) {
    try {
      await message.delete().catch(() => {});
      const harsh = guildConfig.harshness;

      await message.channel.send({
        content: `⚠️ ${message.author}, ${reason}`
      }).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));

      if (harsh >= 2) {
        if (!guildConfig.strikes[message.author.id]) guildConfig.strikes[message.author.id] = 0;
        guildConfig.strikes[message.author.id]++;
        saveConfig();
      }

      if (harsh >= 3) {
        try {
          await message.member.timeout(10 * 60 * 1000, "FilterProtect auto-timeout");
        } catch {}
      }

      if (harsh === 4) {
        const strikes = guildConfig.strikes[message.author.id] || 0;
        if (strikes >= 3) {
          try {
            await message.member.kick("FilterProtect auto-kick (3 strikes)");
          } catch {}
        }
      }

      await logEvent(
        message.guild,
        guildConfig,
        "🚨 FilterProtect Action",
        reason,
        [
          { name: "User", value: `${message.author.tag} (${message.author.id})`, inline: true },
          { name: "Channel", value: `${message.channel}`, inline: true },
          { name: "Content", value: raw || "[no text]", inline: false }
        ]
      );
    } catch (e) {
      console.error("Punish error:", e);
    }
  }

  // TEXT FILTER
  if (modules.textFilter) {
    for (const word of TEXT_FILTER) {
      const wNorm = word.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
      if (!wNorm) continue;
      if (normalized.includes(wNorm)) {
        // category checks
        if (NSFW_WORDS.includes(word) ||
            PROFANITY.includes(word) && modules.profanityFilter ||
            VIOLENCE.includes(word) && modules.violenceFilter ||
            SELF_HARM.includes(word) && modules.selfharmFilter ||
            DRUGS.includes(word) && modules.drugsFilter ||
            GAMBLING.includes(word) && modules.gamblingFilter ||
            SCAMS.includes(word) && modules.scamFilter ||
            GROOMING.includes(word) && modules.groomingFilter ||
            LEET_VARIANTS.includes(word) ||
            BROKEN_WORDS.includes(word) ||
            SYMBOL_VARIANTS.includes(word) ||
            SHORTENED.includes(word)) {
          return punish("Inappropriate text detected.");
        }
      }
    }
  }

  // LINK FILTER
  if (modules.linkFilter || modules.inviteFilter) {
    const linkRegex = /(https?:\/\/[^\s]+)/gi;
    if (linkRegex.test(lower)) {
      if (modules.inviteFilter && (lower.includes("discord.gg") || lower.includes("discord.com/invite"))) {
        return punish("Discord invite link blocked.");
      }
      if (modules.linkFilter) {
        return punish("Link blocked.");
      }
    }
  }

  // SPAM FILTER (advanced)
  if (modules.spamFilter) {
    const now = Date.now();
    const key = `${guildId}-${message.author.id}`;
    if (!spamMap[key]) spamMap[key] = { last: 0, count: 0, lastMsg: "" };
    const data = spamMap[key];

    if (now - data.last < 1500) data.count++;
    else data.count = 1;

    if (raw === data.lastMsg) data.count++;

    data.last = now;
    data.lastMsg = raw;
    spamMap[key] = data;

    const caps = raw.replace(/[^A-Z]/g, "").length;
    const capsRatio = raw.length > 0 ? caps / raw.length : 0;

    const emojiCount = (raw.match(/<a?:\w+:\d+>/g) || []).length;
    const mentionCount = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);

    if (data.count >= 6 || capsRatio > 0.7 || emojiCount >= 8 || mentionCount >= 5) {
      return punish("Spam detected.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
