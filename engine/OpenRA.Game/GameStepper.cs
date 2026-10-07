#region Copyright & License Information
/*
 * Copyright (c) The OpenRA Developers and Contributors
 * This file is part of OpenRA, which is free software. It is made
 * available to you under the terms of the GNU General Public License
 * as published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version. For more
 * information, see COPYING.
 */
#endregion

using System;
using System.Diagnostics;
using OpenRA.Widgets;

namespace OpenRA
{
	/// <summary>
	/// One iteration of the game loop: decides when logic ticks and render ticks run.
	/// The desktop loop drives this from a blocking while/sleep loop; browser hosts
	/// drive it from requestAnimationFrame via <see cref="StepUntilIdle"/>.
	/// The scheduling rules live in the pure <see cref="DecideStep"/> so they can be
	/// unit tested without touching engine globals.
	/// </summary>
	public sealed class GameStepper
	{
		// When the logic has fallen behind by this much, skip the pending
		// updates and start fresh.
		// For example, if we want to update logic every 10 ms but each loop
		// temporarily takes 100 ms, the 'nextLogic' timestamp will be too low
		// and the current timestamp ('now') will have moved on. Even if the
		// update time returns to normal, it will take a long time to catch up
		// (if ever).
		// This also means that the 'logicInterval' cannot be longer than this
		// value.
		internal const int MaxLogicTicksBehind = 250;

		// Try to maintain at least this many FPS during replays, even if it slows down logic.
		// However, if the user has enabled a framerate limit that is even lower
		// than this, then that limit will be used.
		internal const int MinReplayFps = 10;

		[Flags]
		internal enum StepActions : byte
		{
			None = 0,
			TickLogic = 1,
			Render = 2,
			PumpSuspendedInput = 4
		}

		internal struct SchedulerState
		{
			public long NextLogic;
			public long NextRender;
			public long ForcedNextRender;
			public bool RenderBeforeNextTick;

			public SchedulerState(long now)
			{
				NextLogic = now;
				NextRender = now;
				ForcedNextRender = now;
				RenderBeforeNextTick = false;
			}
		}

		internal readonly struct StepInputs
		{
			public readonly int LogicInterval;
			public readonly int RenderInterval;
			public readonly bool WindowIsSuspended;
			public readonly bool ForceRenderAfterTick;

			public StepInputs(int logicInterval, int renderInterval, bool windowIsSuspended, bool forceRenderAfterTick)
			{
				LogicInterval = logicInterval;
				RenderInterval = renderInterval;
				WindowIsSuspended = windowIsSuspended;
				ForceRenderAfterTick = forceRenderAfterTick;
			}
		}

		SchedulerState schedulerState;

		readonly Stopwatch logicWatch = new();

		public bool LastStepRendered { get; private set; }
		public bool LastStepTickedLogic { get; private set; }
		public long LastLogicDurationMs { get; private set; }

		// Invoked after every logic tick with its duration; hosts use this for
		// exhaustive tick-time telemetry (sampling would alias catch-up ticks).
		public Action<long> LogicTickCompleted;

		public GameStepper(long now)
		{
			schedulerState = new SchedulerState(now);
		}

		/// <summary>
		/// The pure scheduling decision: given the current state and inputs, decides
		/// which actions run now, mutates the schedule, and reports the wait until
		/// the next update (0 when more work is pending immediately). Preserves the
		/// exact ordering rules of the traditional game loop.
		/// </summary>
		internal static StepActions DecideStep(ref SchedulerState s, in StepInputs inputs, long now, out long wait)
		{
			wait = 0;

			// If the logic has fallen behind too much, skip it and catch up
			if (now - s.NextLogic > MaxLogicTicksBehind)
				s.NextLogic = now;

			// When's the next update (logic or render)
			var nextUpdate = Math.Min(s.NextLogic, s.NextRender);
			if (now < nextUpdate)
			{
				wait = nextUpdate - now;
				return StepActions.None;
			}

			var actions = StepActions.None;

			// Evaluated before a logic tick may set RenderBeforeNextTick below:
			// the render forced by a tick happens on the *next* iteration.
			var forceRender = s.RenderBeforeNextTick || now >= s.ForcedNextRender;

			if (now >= s.NextLogic && !s.RenderBeforeNextTick)
			{
				s.NextLogic += inputs.LogicInterval;
				actions |= StepActions.TickLogic;

				// Force at least one render per tick during regular gameplay
				if (inputs.ForceRenderAfterTick)
					s.RenderBeforeNextTick = true;
			}

			var haveSomeTimeUntilNextLogic = now < s.NextLogic;
			var isTimeToRender = now >= s.NextRender;
			if (!inputs.WindowIsSuspended && ((isTimeToRender && haveSomeTimeUntilNextLogic) || forceRender))
			{
				s.NextRender = now + inputs.RenderInterval;

				// Pick the minimum allowed FPS (the lower between 'MinReplayFps'
				// and the user's max frame rate) and convert it to maximum time
				// allowed between screen updates.
				// We do this before rendering to include the time rendering takes
				// in this interval.
				s.ForcedNextRender = now + Math.Max(1000 / MinReplayFps, inputs.RenderInterval);

				actions |= StepActions.Render;
				s.RenderBeforeNextTick = false;
			}

			// Simulate a render tick if it was time to render but we skip actually rendering
			if (inputs.WindowIsSuspended && isTimeToRender)
			{
				// Make sure that nextUpdate is set to a proper minimum interval
				s.NextRender = now + inputs.RenderInterval;
				actions |= StepActions.PumpSuspendedInput;

				// Ensure that we still logic tick despite not rendering
				s.RenderBeforeNextTick = false;
			}

			return actions;
		}

		static StepInputs BuildInputs()
		{
			var logicInterval = Ui.Timestep;
			var logicWorld = Game.WorldRenderer?.World;

			// ReplayTimestep = 0 means the replay is paused: we need to keep logicInterval as UI.Timestep to avoid breakage
			if (logicWorld != null && (!logicWorld.IsReplay || logicWorld.ReplayTimestep != 0))
				logicInterval = logicWorld == Game.OrderManager.World ? Game.OrderManager.SuggestedTimestep : logicWorld.Timestep;

			// Ideal time between screen updates
			var renderInterval = logicInterval;
			if (!Game.Settings.Graphics.CapFramerateToGameFps)
			{
				var maxFramerate = Game.Settings.Graphics.CapFramerate ? Game.Settings.Graphics.MaxFramerate.Clamp(1, 1000) : 1000;
				renderInterval = 1000 / maxFramerate;
			}

			// Tick as fast as possible while restoring game saves, capping rendering at 5 FPS
			var world = Game.OrderManager.World;
			if (world != null && world.IsLoadingGameSave)
			{
				logicInterval = 1;
				renderInterval = 200;
			}

			var forceRenderAfterTick = world != null && !world.IsLoadingGameSave && !world.IsReplay;
			return new StepInputs(logicInterval, renderInterval, Game.Renderer.WindowIsSuspended, forceRenderAfterTick);
		}

		/// <summary>
		/// Runs at most one logic tick and at most one render tick, using the same
		/// scheduling rules as the traditional game loop. Returns the number of
		/// milliseconds until the next scheduled update, or 0 when more work is
		/// pending immediately.
		/// </summary>
		public long Step(long now)
		{
			LastStepRendered = false;
			LastStepTickedLogic = false;

			var actions = DecideStep(ref schedulerState, BuildInputs(), now, out var wait);

			if (actions.HasFlag(StepActions.TickLogic))
			{
				logicWatch.Restart();
				Game.LogicTick();
				LastLogicDurationMs = logicWatch.ElapsedMilliseconds;
				LastStepTickedLogic = true;
				LogicTickCompleted?.Invoke(LastLogicDurationMs);
			}

			if (actions.HasFlag(StepActions.Render))
			{
				Game.RenderTick();
				LastStepRendered = true;
			}

			// Still process window events while suspended to allow a restore to come through
			if (actions.HasFlag(StepActions.PumpSuspendedInput))
				Game.Renderer.Window.PumpInput(new NullInputHandler());

			return wait;
		}

		/// <summary>
		/// Runs pending work for a single animation frame: up to <paramref name="maxLogicTicks"/>
		/// logic ticks to catch up, stopping after the first render. Browser hosts call this
		/// once per requestAnimationFrame callback.
		/// </summary>
		public void StepUntilIdle(Func<long> clock, int maxLogicTicks = 4)
		{
			// Hard bound on iterations so a scheduling edge case can never hang the frame
			var logicTicks = 0;
			for (var i = 0; i < 4 * maxLogicTicks && logicTicks < maxLogicTicks; i++)
			{
				if (Game.State != RunStatus.Running)
					return;

				if (Step(clock()) > 0 || LastStepRendered)
					return;

				if (LastStepTickedLogic)
					logicTicks++;
			}
		}
	}
}
