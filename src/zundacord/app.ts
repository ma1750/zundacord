import { entersState, getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus } from "@discordjs/voice"
import { ActionRowBuilder, ApplicationCommandType, ButtonBuilder, ButtonInteraction, ButtonStyle, Client, CommandInteraction, ContextMenuCommandBuilder, EmbedBuilder, GatewayIntentBits, Interaction, Message, MessageContextMenuCommandInteraction, Routes, SelectMenuBuilder, SelectMenuInteraction, SlashCommandBuilder } from "discord.js"
import { getReadableString } from "./utils"
import { StyledSpeaker, VoiceVoxClient } from "./voicevox"
import { Player } from "./player"
import { IConfigManager, JsonConfig } from "./config"
import { logger } from "./logger"

const COLOR_SUCCESS = 0x47ff94
const COLOR_FAILURE = 0xff4a47
const COLOR_ACTION = 0x45b5ff

const log = logger.child({ "module": "zundacord/app" })


function zundaEmbed(): EmbedBuilder {
    return new EmbedBuilder()
        .setFooter({ text: "sarisia/zundacord" })
}


export class Zundacord {
    private readonly token: string

    private readonly config: IConfigManager
    private readonly voicevox: VoiceVoxClient
    private readonly client: Client
    private readonly guildPlayers: Map<string, Player> = new Map()

    private applicationId: string = ""

    constructor(token: string, apiEndpoint: string) {
        this.token = token

        this.config = new JsonConfig()
        this.voicevox = new VoiceVoxClient(apiEndpoint)
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.MessageContent,
            ]
        })

        // register events
        this.client.on("ready", this.onReady.bind(this))
        this.client.on("messageCreate", this.onMessageCreate.bind(this))
        this.client.on("interactionCreate", this.onInteractionCreate.bind(this))
    }

    async start(): Promise<void> {
        // init config
        await this.config.init()
        await this.client.login(this.token)
    }

    async onReady() {
        log.info("Connected to Discord!")

        const applicationId = this.client.application?.id
        if (!applicationId) {
            throw new Error("applicationId is missing (BUG)")
        }
        this.applicationId = applicationId
        log.debug(`application id is ${applicationId}`)

        await this.registerCommands()
        log.info("Ready!")
    }

    async onInteractionCreate(interaction: Interaction) {
        if (!interaction.inCachedGuild()) {
            // do not handle
            log.debug(`guild not cached: ${interaction.guildId}`)
            return
        }

        if (interaction.isChatInputCommand()) {
            // slash command
            // voice, join, skip

            switch (interaction.commandName) {
                case "voice":
                    await this.slashVoice(interaction)
                    break
                case "join":
                    await this.slashJoin(interaction)
                    break
                case "skip":
                    await this.slashSkip(interaction)
                    break
                default:
                    log.debug(`unknown slash command: ${interaction.commandName}`)
            }
        } else if (interaction.isMessageContextMenuCommand()) {
            switch (interaction.commandName) {
                case "Read this message":
                    await this.messageContextReadThisMessage(interaction)
                    break
                default:
                    log.debug(`unknown message context menu command: ${interaction.commandName}`)
            }
        } else if (interaction.isSelectMenu()) {
            const cmd = interaction.customId.split("/", 1)[0]
            switch (cmd) {
                case "speakerSelected":
                    await this.selectMenuSpeakerSelected(interaction)
                    break
                default:
                    log.debug(`unknown select menu command: ${interaction.customId}`)
            }
        } else if (interaction.isButton()) {
            const cmd = interaction.customId.split("/", 1)[0]
            switch (cmd) {
                case "speakerStyleSelected":
                    await this.buttonSpeakerStyleSeleceted(interaction)
                    break
                default:
                    log.debug(`unknown button command: ${interaction.customId}`)
            }
        } else {
            log.debug(`unknown interaction type: ${interaction.type}`)
        }
    }

    async onMessageCreate(msg: Message) {
        // ignore the bot itself
        if (msg.author.id === this.applicationId) {
            log.debug("ignore the bot itself")
            return
        }

        if (!msg.inGuild()) {
            log.debug("cannot handle non-guild messages")
            return
        }

        let styleId = await this.config.getMemberVoiceStyleId(msg.guildId, msg.author.id)
        if (styleId === undefined) {
            // user didn't call /voice before,
            // means they haven't agreed to tos yet
            return
        }

        this.queueMessage(msg, styleId)
    }

    async slashVoice(interaction: CommandInteraction<"cached">) {
        log.debug("voice")

        const playerStyleId = await this.config.getMemberVoiceStyleId(interaction.guildId, interaction.user.id)
        let speaker: StyledSpeaker | undefined
        if (playerStyleId !== undefined) {
            speaker = await this.voicevox.getSpeakerById(`${playerStyleId}`)
        }

        interaction.reply({
            ephemeral: true,
            embeds: [
                this.embedSelectVoiceHeader(speaker)
            ],
            components: [
                await this.getVoiceSpeakerSelectMenu()
            ]
        })
    }

    async slashJoin(interaction: CommandInteraction<"cached">) {
        log.debug("join")

        const embed = (() => {
            // join the voice
            // check current voice
            if (getVoiceConnection(interaction.guildId)) {
                return zundaEmbed()
                    .setColor(COLOR_SUCCESS)
                    .setTitle("Already joined!")
                    .setDescription("The bot is already in voice")
            }

            // true join
            const member = interaction.guild.members.cache.get(interaction.user.id)
            if (!member) {
                return zundaEmbed()
                    .setColor(COLOR_FAILURE)
                    .setTitle("Cannot join")
                    .setDescription("You are not in guild")
            }

            const memberVoiceChannel = member.voice.channel
            if (!memberVoiceChannel) {
                return zundaEmbed()
                    .setColor(COLOR_FAILURE)
                    .setTitle("Cannot join")
                    .setDescription("You need to join to the voice first")
            }

            const vc = joinVoiceChannel({
                guildId: interaction.guildId,
                channelId: memberVoiceChannel.id,
                adapterCreator: interaction.guild.voiceAdapterCreator
            })
            // register disconnection handler
            vc.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
                log.info(`[${interaction.guild.name} (${interaction.guildId})] Disconnected from voice. Waiting...`)
                try {
                    await Promise.race([
                        entersState(vc, VoiceConnectionStatus.Signalling, 5000),
                        entersState(vc, VoiceConnectionStatus.Connecting, 5000)
                    ])
                    log.info(`[${interaction.guild.name} (${interaction.guildId})] Reconnecting starts`)
                } catch (e) {
                    // real disconnect (by user)
                    log.info(`[${interaction.guild.name} (${interaction.guildId})] Seems disconnected by user. Destroy.`)
                    vc.destroy()
                    // remove current audio player
                    this.guildPlayers.delete(interaction.guildId)
                }
            })
            // create audio player for this voice channel
            const player = new Player(this.voicevox)
            player.setStreamTarget(vc)
            this.guildPlayers.set(interaction.guildId, player)

            return zundaEmbed()
                .setColor(COLOR_SUCCESS)
                .setTitle("Joined!")
                .setDescription(`Joined to ${memberVoiceChannel.name}`)
        })()

        interaction.reply({
            ephemeral: true,
            embeds: [embed]
        })
    }

    async slashSkip(interaction: CommandInteraction) {
        log.debug("skip")

        const embed = (() => {
            if (!interaction.inCachedGuild()) {
                return zundaEmbed()
                    .setColor(COLOR_FAILURE)
                    .setTitle("Cannot skip")
                    .setDescription("The bot is not in the guild")
            }

            const player = this.guildPlayers.get(interaction.guildId)
            if (!player) {
                return zundaEmbed()
                    .setColor(COLOR_FAILURE)
                    .setTitle("Cannot skip")
                    .setDescription("The bot is not in voice")
            }

            player.skipCurrentMessage()
            return zundaEmbed()
                .setColor(COLOR_SUCCESS)
                .setTitle("Skipped!")
                .setDescription("Skipped the message")
        })()

        interaction.reply({
            ephemeral: true,
            embeds: [embed]
        })
    }

    async messageContextReadThisMessage(interaction: MessageContextMenuCommandInteraction<"cached">) {
        const styleId = await this.config.getMemberVoiceStyleId(interaction.guildId, interaction.user.id)
        if (styleId === undefined) {
            interaction.reply({
                ephemeral: true,
                embeds: [
                    zundaEmbed()
                        .setColor(COLOR_FAILURE)
                        .setTitle("Cannot read")
                        .setDescription("Set your voice with /voice first")
                ]
            })
            return
        }

        this.queueMessage(interaction.targetMessage, styleId)
        interaction.reply({
            ephemeral: true,
            embeds: [
                zundaEmbed()
                    .setColor(COLOR_SUCCESS)
                    .setTitle("Successfully enqueued!")
                    .setDescription("The message is successfully enqueued to be read")
            ]
        })
    }

    async selectMenuSpeakerSelected(interaction: SelectMenuInteraction<"cached">) {
        const speakerUuid = interaction.values[0]

        const currentUserSpeakerStyle = await this.config.getMemberVoiceStyleId(interaction.guildId, interaction.user.id)
        let speaker: StyledSpeaker | undefined
        if (currentUserSpeakerStyle !== undefined) {
            speaker = await this.voicevox.getSpeakerById(`${currentUserSpeakerStyle}`)
        }
        const info = await this.voicevox.speakerInfo(speakerUuid)

        interaction.update({
            embeds: [
                this.embedSelectVoiceHeader(speaker),
                zundaEmbed()
                    .setColor(COLOR_ACTION)
                    .setTitle("You need to agree to the terms of service")
                    .setDescription(info.policy)
            ],
            components: [
                await this.getVoiceSpeakerSelectMenu(speakerUuid),
                ...await this.getVoiceSpeakerStyleButtons(speakerUuid)
            ]
        })
    }

    async getVoiceSpeakerSelectMenu(selectedSpeakerUuid?: string): Promise<ActionRowBuilder<SelectMenuBuilder>> {
        const speakers = await this.voicevox.getSpeakers()

        // TODO: make pager
        return new ActionRowBuilder<SelectMenuBuilder>()
            .addComponents(new SelectMenuBuilder()
                .setCustomId("speakerSelected")
                .setPlaceholder("Choose the speaker...")
                .addOptions(
                    ...speakers.map((s) => {
                        return {
                            label: s.name,
                            description: s.styles.map((st) => {
                                return st.name
                            }).join(", "),
                            value: s.speaker_uuid,
                            default: s.speaker_uuid === selectedSpeakerUuid
                        }
                    })
                )
            )
    }

    async getVoiceSpeakerStyleButtons(speakerUuid: string): Promise<ActionRowBuilder<ButtonBuilder>[]> {
        const speaker = await this.voicevox.getSpeakerByUUID(speakerUuid)
        if (!speaker) {
            throw new Error(`speakerUuid does not exist: ${speakerUuid}`)
        }

        // TODO: make pager
        return [
            new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    ...speaker.styles.map((st) => {
                        return new ButtonBuilder()
                            .setLabel(st.name)
                            .setCustomId(`speakerStyleSelected/${st.id}`)
                            .setStyle(ButtonStyle.Primary)
                    })
                )
        ]
    }

    async buttonSpeakerStyleSeleceted(interaction: ButtonInteraction<"cached">) {
        const styleId = interaction.customId.replace(/^speakerStyleSelected\//, "")

        const speaker = await this.voicevox.getSpeakerById(styleId)
        if (!speaker) {
            interaction.update({
                embeds: [
                    zundaEmbed()
                        .setColor(COLOR_FAILURE)
                        .setTitle("Cannot set voice")
                        .setDescription("Specified speaker / style is not found")
                ],
                components: []
            })
            return
        }

        this.config.setMemberVoiceStyleId(interaction.guildId, interaction.user.id, speaker.styleId)
        // TODO: this is useless at this moment due to VOICEVOX engine's limitation
        // see #3
        this.voicevox.doInitializeSpeaker(`${speaker.styleId}`)
        await interaction.update({
            embeds: [
                zundaEmbed()
                    .setColor(COLOR_SUCCESS)
                    .setTitle("Voice is set!")
                    .setFields(
                        {
                            "name": "Speaker",
                            "value": speaker.speaker.name,
                            "inline": true,
                        },
                        {
                            "name": "Style",
                            "value": speaker.styleName,
                            "inline": true,
                        },
                    )
            ],
            components: []
        })
    }

    embedSelectVoiceHeader(speaker?: StyledSpeaker): EmbedBuilder {
        return zundaEmbed()
            .setColor(COLOR_ACTION)
            .setTitle("Select your voice!")
            .setFields(
                {
                    "name": "Speaker",
                    "value": speaker?.speaker.name || "(Not set)",
                    "inline": true,
                },
                {
                    "name": "Style",
                    "value": speaker?.styleName || "(Not set)",
                    "inline": true,
                },
            )
    }

    async registerCommands() {
        log.info("Registering commands...")

        const commands = [
            new SlashCommandBuilder().setName("voice").setDescription("Set the speaker voice / style"),
            new SlashCommandBuilder().setName("join").setDescription("Join the bot to the voice"),
            new SlashCommandBuilder().setName("skip").setDescription("Skip the message reading now"),
            new ContextMenuCommandBuilder().setName("Read this message").setType(ApplicationCommandType.Message)
        ].map(c => c.toJSON())

        await this.client.rest.put(
            Routes.applicationCommands(this.applicationId),
            { body: commands }
        )

        log.info("Commands are registered!")
    }

    queueMessage(msg: Message<true>, styleId: number) {
        const player = this.guildPlayers.get(msg.guildId)
        if (!player) {
            log.debug(`[${msg.guild.name} (${msg.guildId})] bot is not in vc (player not found)`)
            return
        }

        const readableStr = getReadableString(msg.content)
        log.debug(`${msg.content}\n => ${readableStr}`)

        player.queueMessage({
            styleId: styleId,
            message: readableStr,
        })
    }
}
