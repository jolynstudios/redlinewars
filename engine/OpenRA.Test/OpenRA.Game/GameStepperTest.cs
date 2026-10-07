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

using NUnit.Framework;

namespace OpenRA.Test
{
	[TestFixture]
	sealed class GameStepperTest
	{
		readonly record struct FrameResult(int Iterations, int LogicTicks, int Renders, int SuspendedInputPumps);

		static FrameResult SimulateStepUntilIdle(
			ref GameStepper.SchedulerState state,
			in GameStepper.StepInputs inputs,
			long now,
			int maxLogicTicks)
		{
			var iterations = 0;
			var logicTicks = 0;
			var renders = 0;
			var suspendedInputPumps = 0;
			for (var i = 0; i < 4 * maxLogicTicks && logicTicks < maxLogicTicks; i++)
			{
				iterations++;
				var actions = GameStepper.DecideStep(ref state, inputs, now, out var wait);
				if ((actions & GameStepper.StepActions.TickLogic) != 0)
					logicTicks++;
				if ((actions & GameStepper.StepActions.Render) != 0)
					renders++;
				if ((actions & GameStepper.StepActions.PumpSuspendedInput) != 0)
					suspendedInputPumps++;

				if (wait > 0 || renders > 0)
					break;
			}

			return new FrameResult(iterations, logicTicks, renders, suspendedInputPumps);
		}

		[TestCase(TestName = "Logic scheduling clamps after falling too far behind")]
		public void LogicSchedulingClampsAfterLongDelay()
		{
			var state = new GameStepper.SchedulerState(0)
			{
				NextRender = long.MaxValue,
				ForcedNextRender = long.MaxValue
			};
			var inputs = new GameStepper.StepInputs(40, 16, false, false);
			const long Now = GameStepper.MaxLogicTicksBehind + 1L;

			var actions = GameStepper.DecideStep(ref state, inputs, Now, out var wait);

			Assert.Multiple(() =>
			{
				Assert.That(actions, Is.EqualTo(GameStepper.StepActions.TickLogic));
				Assert.That(wait, Is.Zero);
				Assert.That(state.NextLogic, Is.EqualTo(Now + inputs.LogicInterval));
			});
		}

		[TestCase(TestName = "A regular logic tick renders before the following logic tick")]
		public void RegularLogicTickForcesRenderBeforeNextTick()
		{
			var state = new GameStepper.SchedulerState(0)
			{
				NextRender = 100,
				ForcedNextRender = 100
			};
			var inputs = new GameStepper.StepInputs(40, 16, false, true);

			var firstActions = GameStepper.DecideStep(ref state, inputs, 0, out var firstWait);
			var secondActions = GameStepper.DecideStep(ref state, inputs, 40, out var secondWait);

			Assert.Multiple(() =>
			{
				Assert.That(firstActions, Is.EqualTo(GameStepper.StepActions.TickLogic));
				Assert.That(firstWait, Is.Zero);
				Assert.That(secondActions, Is.EqualTo(GameStepper.StepActions.Render));
				Assert.That(secondWait, Is.Zero);
				Assert.That(state.RenderBeforeNextTick, Is.False);
				Assert.That(state.NextLogic, Is.EqualTo(40));
			});
		}

		[TestCase(TestName = "The scheduler reports the wait until the next render")]
		public void SchedulerReportsWaitUntilNextUpdate()
		{
			var state = new GameStepper.SchedulerState(0);
			var inputs = new GameStepper.StepInputs(40, 16, false, false);
			var initialActions = GameStepper.DecideStep(ref state, inputs, 0, out var initialWait);

			var actions = GameStepper.DecideStep(ref state, inputs, 1, out var wait);

			Assert.Multiple(() =>
			{
				Assert.That(initialActions, Is.EqualTo(GameStepper.StepActions.TickLogic | GameStepper.StepActions.Render));
				Assert.That(initialWait, Is.Zero);
				Assert.That(actions, Is.EqualTo(GameStepper.StepActions.None));
				Assert.That(wait, Is.EqualTo(15));
			});
		}

		[TestCase(TestName = "StepUntilIdle scheduling stops at the logic tick cap")]
		public void StepUntilIdleStopsAtLogicTickCap()
		{
			var state = new GameStepper.SchedulerState(0)
			{
				NextRender = long.MaxValue,
				ForcedNextRender = long.MaxValue
			};
			var inputs = new GameStepper.StepInputs(1, 16, false, false);

			var result = SimulateStepUntilIdle(ref state, inputs, 100, 4);

			Assert.Multiple(() =>
			{
				Assert.That(result.Iterations, Is.EqualTo(4));
				Assert.That(result.LogicTicks, Is.EqualTo(4));
				Assert.That(result.Renders, Is.Zero);
			});
		}

		[TestCase(TestName = "StepUntilIdle scheduling stops after the first render")]
		public void StepUntilIdleStopsAfterFirstRender()
		{
			var state = new GameStepper.SchedulerState(0);
			var inputs = new GameStepper.StepInputs(40, 16, false, false);

			var result = SimulateStepUntilIdle(ref state, inputs, 0, 4);

			Assert.Multiple(() =>
			{
				Assert.That(result.Iterations, Is.EqualTo(1));
				Assert.That(result.LogicTicks, Is.EqualTo(1));
				Assert.That(result.Renders, Is.EqualTo(1));
			});
		}

		[TestCase(TestName = "StepUntilIdle scheduling has a hard iteration bound")]
		public void StepUntilIdleHasHardIterationBound()
		{
			var state = new GameStepper.SchedulerState(0)
			{
				NextLogic = long.MaxValue
			};

			// A zero render interval models a pathological schedule that makes no progress:
			// every decision pumps suspended input but remains due at the same timestamp.
			var inputs = new GameStepper.StepInputs(40, 0, true, false);

			var result = SimulateStepUntilIdle(ref state, inputs, 0, 4);

			Assert.Multiple(() =>
			{
				Assert.That(result.Iterations, Is.EqualTo(16));
				Assert.That(result.LogicTicks, Is.Zero);
				Assert.That(result.Renders, Is.Zero);
				Assert.That(result.SuspendedInputPumps, Is.EqualTo(16));
			});
		}
	}
}
