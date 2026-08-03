//! Neoxify's installer window.
//!
//! The file a customer downloads. It draws its own window -- borderless,
//! dark, rounded, one button -- and runs the real NSIS installer inside
//! it silently.
//!
//! # Why this exists rather than more NSIS
//!
//! NSIS's window is a Win32 dialog with a system title bar and common
//! controls. It can be recoloured, and was; it cannot stop looking like
//! a wizard, because the frame and the controls are the operating
//! system's. Everything here is drawn by us into a plain framebuffer, so
//! the only thing Windows contributes is the window rectangle.
//!
//! # Why software rendering
//!
//! An installer runs on a machine we know nothing about, before any of
//! our software is on it -- a fresh image, a VM with a basic display
//! adapter, a laptop on a generic driver. A GPU swapchain is one more
//! thing that can fail before the customer has anything to fall back
//! on. This composites on the CPU into a 440x540 buffer, which is
//! nothing, and cannot fail for want of a driver.

#![windows_subsystem = "windows"]

mod installer;
mod text;
mod ui;

use std::sync::mpsc::{channel, Receiver};
use std::time::Instant;

use softbuffer::{Context, Surface};
use tiny_skia::Pixmap;
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId, WindowLevel};

use installer::Progress;
use ui::{Layout, Phase};

/// The mark, from the same icon set the app itself ships.
const LOGO_PNG: &[u8] = include_bytes!("../../src-tauri/icons/128x128@2x.png");

fn main() {
    // A build with no installer inside it is a developer artifact and
    // must never be mistaken for a broken download. See build.rs.
    if !installer::has_payload() {
        message_box(
            "This copy of the installer is incomplete and cannot install Neoxify.\n\n\
             Please download it again from neoxify.net.",
        );
        return;
    }

    let Some(fonts) = text::load() else {
        message_box("Neoxify's installer could not load a system font, so it cannot start.");
        return;
    };

    let Ok(event_loop) = EventLoop::new() else {
        message_box("Neoxify's installer could not open a window.");
        return;
    };
    event_loop.set_control_flow(ControlFlow::Wait);
    let _ = event_loop.run_app(&mut App::new(fonts));
}

struct App {
    fonts: text::Fonts,
    logo: Option<Pixmap>,
    window: Option<std::rc::Rc<Window>>,
    surface: Option<Surface<std::rc::Rc<Window>, std::rc::Rc<Window>>>,
    phase: Phase,
    pointer: (f32, f32),
    pressed_button: bool,
    started: Instant,
    progress: Option<Receiver<Progress>>,
}

impl App {
    fn new(fonts: text::Fonts) -> Self {
        Self {
            fonts,
            logo: decode_logo(),
            window: None,
            surface: None,
            phase: Phase::Idle { hovering: false, pressing: false },
            pointer: (-1.0, -1.0),
            pressed_button: false,
            started: Instant::now(),
            progress: None,
        }
    }

    fn scale(&self) -> f32 {
        self.window.as_ref().map_or(1.0, |w| w.scale_factor() as f32)
    }

    /// Pointer position in logical coordinates, which is what the
    /// layout is expressed in.
    fn hit(&self, rect: tiny_skia::Rect) -> bool {
        let (x, y) = self.pointer;
        x >= rect.left() && x <= rect.right() && y >= rect.top() && y <= rect.bottom()
    }

    fn redraw(&mut self) {
        let (Some(window), Some(surface)) = (self.window.as_ref(), self.surface.as_mut()) else {
            return;
        };
        let size = window.inner_size();
        let (Some(w), Some(h)) =
            (std::num::NonZeroU32::new(size.width), std::num::NonZeroU32::new(size.height))
        else {
            return;
        };
        if surface.resize(w, h).is_err() {
            return;
        }
        let Some(mut pixmap) = Pixmap::new(size.width, size.height) else { return };

        let layout = Layout { scale: window.scale_factor() as f32 };
        ui::paint(&mut pixmap, &self.fonts, &layout, &self.phase, self.logo.as_ref());

        let Ok(mut buffer) = surface.buffer_mut() else { return };
        // softbuffer wants 0RGB; tiny-skia hands back premultiplied
        // RGBA. Everything drawn here is opaque, so the premultiplied
        // channels are already the colour we want.
        for (dst, src) in buffer.iter_mut().zip(pixmap.pixels()) {
            *dst = (src.red() as u32) << 16 | (src.green() as u32) << 8 | src.blue() as u32;
        }
        let _ = buffer.present();
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attributes = Window::default_attributes()
            .with_title("Neoxify Setup")
            .with_inner_size(LogicalSize::new(ui::WIDTH, ui::HEIGHT))
            .with_resizable(false)
            // No system frame: the title bar and its buttons are the
            // one part of a Win32 window that cannot be restyled, and
            // they are what made the previous installer look like a
            // wizard however it was coloured.
            .with_decorations(false)
            .with_window_level(WindowLevel::Normal);

        let Ok(window) = event_loop.create_window(attributes) else {
            event_loop.exit();
            return;
        };
        let window = std::rc::Rc::new(window);
        round_corners(&window);

        match Context::new(window.clone()).and_then(|c| Surface::new(&c, window.clone())) {
            Ok(surface) => self.surface = Some(surface),
            Err(_) => {
                event_loop.exit();
                return;
            }
        }
        self.window = Some(window);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let layout = Layout { scale: self.scale() };

        match event {
            WindowEvent::CloseRequested => event_loop.exit(),

            WindowEvent::CursorMoved { position, .. } => {
                let s = self.scale() as f64;
                self.pointer = ((position.x / s) as f32, (position.y / s) as f32);
                // Computed before the match so the hit test is not
                // borrowing self while the phase is held mutably.
                let over = self.hit(layout.button());
                if let Phase::Idle { hovering, .. } = &mut self.phase {
                    if *hovering != over {
                        *hovering = over;
                        if let Some(w) = &self.window {
                            w.request_redraw();
                        }
                    }
                }
            }

            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                let on_close = self.hit(layout.close());
                let on_button = self.hit(layout.button());

                match state {
                    ElementState::Pressed => {
                        if on_close {
                            event_loop.exit();
                            return;
                        }
                        if on_button && matches!(self.phase, Phase::Idle { .. }) {
                            self.pressed_button = true;
                            self.phase = Phase::Idle { hovering: true, pressing: true };
                        } else if let Some(w) = &self.window {
                            // Anywhere else drags the window. Without a
                            // title bar this is the only way to move it,
                            // and a window that cannot be moved feels
                            // broken long before anyone works out why.
                            let _ = w.drag_window();
                        }
                        if let Some(w) = &self.window {
                            w.request_redraw();
                        }
                    }
                    ElementState::Released => {
                        if self.pressed_button && on_button {
                            let (tx, rx) = channel();
                            installer::start(tx);
                            self.progress = Some(rx);
                            self.started = Instant::now();
                            self.phase = Phase::Installing { spinner: 0.0 };
                            event_loop.set_control_flow(ControlFlow::Poll);
                        } else if self.pressed_button {
                            self.phase = Phase::Idle { hovering: on_button, pressing: false };
                        }
                        self.pressed_button = false;
                        if let Some(w) = &self.window {
                            w.request_redraw();
                        }
                    }
                }
            }

            WindowEvent::RedrawRequested => self.redraw(),

            WindowEvent::ScaleFactorChanged { .. } => {
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
            }

            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        let Phase::Installing { spinner } = &mut self.phase else { return };
        // Two seconds a lap. Fast enough to read as working, slow enough
        // not to look frantic while something genuinely slow happens.
        *spinner = self.started.elapsed().as_secs_f32() / 2.0;

        if let Some(rx) = &self.progress {
            match rx.try_recv() {
                Ok(Progress::Finished) => {
                    // Nothing to celebrate on screen: the app itself is
                    // about to open, which is the only confirmation
                    // anyone actually wants.
                    event_loop.exit();
                    return;
                }
                Ok(Progress::Failed(message)) => {
                    self.phase = Phase::Failed(message);
                    self.progress = None;
                    event_loop.set_control_flow(ControlFlow::Wait);
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    self.phase =
                        Phase::Failed("The installer stopped unexpectedly.".to_string());
                    self.progress = None;
                    event_loop.set_control_flow(ControlFlow::Wait);
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }

        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }
}

/// Windows 11's rounded window corners. A no-op anywhere else, which is
/// why the result is not checked.
fn round_corners(window: &Window) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = window.window_handle() else { return };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else { return };

    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;
    // SAFETY: a live HWND from the window we just created, and a u32
    // passed with its real size.
    unsafe {
        windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(
            isize::from(win32.hwnd) as *mut core::ffi::c_void,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &DWMWCP_ROUND as *const u32 as *const core::ffi::c_void,
            4,
        );
    }
}

fn decode_logo() -> Option<Pixmap> {
    let decoder = png::Decoder::new(LOGO_PNG);
    let mut reader = decoder.read_info().ok()?;
    let mut raw = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut raw).ok()?;
    if info.color_type != png::ColorType::Rgba {
        return None;
    }

    let mut pixmap = Pixmap::new(info.width, info.height)?;
    for (dst, src) in pixmap.pixels_mut().iter_mut().zip(raw.chunks_exact(4)) {
        // tiny-skia stores premultiplied alpha; PNG does not.
        let a = src[3] as u32;
        let p = |c: u8| ((c as u32 * a) / 255) as u8;
        *dst = tiny_skia::PremultipliedColorU8::from_rgba(p(src[0]), p(src[1]), p(src[2]), a as u8)?;
    }
    Some(pixmap)
}

/// The last-resort way to say something when there is no window yet.
fn message_box(text: &str) {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let title: Vec<u16> = "Neoxify Setup".encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: both strings are NUL-terminated and outlive the call.
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
            std::ptr::null_mut(),
            wide.as_ptr(),
            title.as_ptr(),
            windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR,
        );
    }
}
