"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type VideoItem = {
  id: number;
  video_url: string;
  created_at: string;
  uploader_token: string | null;
  like_count: number | null;
  comment_count: number | null;
};

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const animationRef = useRef<number | null>(null);

  const [recording, setRecording] = useState(false);
  const [videoURL, setVideoURL] = useState("");
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [uploading, setUploading] = useState(false);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [userToken, setUserToken] = useState("");

  useEffect(() => {
    let token = localStorage.getItem("uploader_token");

    if (!token) {
      token = crypto.randomUUID();
      localStorage.setItem("uploader_token", token);
    }

    setUserToken(token);
    startCamera();
    fetchVideos();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true,
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        videoRef.current.onloadeddata = () => {
          drawMirrorCanvas();
        };

        setTimeout(() => {
          drawMirrorCanvas();
        }, 500);
      }
    } catch (error) {
      console.error(error);
      alert("無法開啟相機，請確認已允許相機與麥克風權限");
    }
  }

  function drawMirrorCanvas() {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = video.videoWidth || 720;
    canvas.height = video.videoHeight || 1280;

    function draw() {
      if (!video || !canvas || !ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
      ctx.restore();

      animationRef.current = requestAnimationFrame(draw);
    }

    draw();
  }

  async function fetchVideos() {
    const { data, error } = await supabase
      .from("videos")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      return;
    }

    setVideos(data || []);
  }

  function startRecording() {
    const canvas = canvasRef.current;
    const videoStream = videoRef.current?.srcObject as MediaStream;

    if (!canvas || !videoStream) {
      alert("尚未取得相機畫面");
      return;
    }

    chunks.current = [];

    const canvasStream = canvas.captureStream(30);

    videoStream.getAudioTracks().forEach((track) => {
      canvasStream.addTrack(track);
    });

    const recorder = new MediaRecorder(canvasStream, {
      mimeType: "video/webm",
    });

    recorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);

      setVideoBlob(blob);
      setVideoURL(url);
    };

    recorder.start();
    setRecording(true);
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  async function uploadVideo() {
    if (!videoBlob) {
      alert("請先錄影");
      return;
    }

    setUploading(true);

    const fileName = `video-${Date.now()}.webm`;

    const { error: uploadError } = await supabase.storage
      .from("susu")
      .upload(fileName, videoBlob, {
        contentType: "video/webm",
      });

    if (uploadError) {
      console.error(uploadError);
      alert("影片上傳失敗");
      setUploading(false);
      return;
    }

    const { data } = supabase.storage.from("susu").getPublicUrl(fileName);

    const { error: insertError } = await supabase.from("videos").insert([
      {
        video_url: data.publicUrl,
        uploader_token: userToken,
        like_count: 0,
        comment_count: 0,
      },
    ]);

    if (insertError) {
      console.error(insertError);
      alert("資料庫寫入失敗");
      setUploading(false);
      return;
    }

    alert("影片上傳成功");

    setUploading(false);
    setVideoURL("");
    setVideoBlob(null);
    fetchVideos();
  }

  async function likeVideo(item: VideoItem) {
    const { data: existingLike } = await supabase
      .from("likes")
      .select("*")
      .eq("video_id", item.id)
      .eq("voter_token", userToken)
      .maybeSingle();

    if (existingLike) {
      alert("你已點讚過");
      return;
    }

    const { error } = await supabase.from("likes").insert([
      {
        video_id: item.id,
        voter_token: userToken,
      },
    ]);

    if (error) {
      console.error(error);
      alert("點讚失敗");
      return;
    }

    await supabase
      .from("videos")
      .update({ like_count: (item.like_count || 0) + 1 })
      .eq("id", item.id);

    fetchVideos();
  }

  async function addComment(item: VideoItem) {
    const content = prompt("請輸入留言");

    if (!content || !content.trim()) return;

    const { error } = await supabase.from("comments").insert([
      {
        video_id: item.id,
        content: content.trim(),
      },
    ]);

    if (error) {
      console.error(error);
      alert("留言失敗");
      return;
    }

    await supabase
      .from("videos")
      .update({ comment_count: (item.comment_count || 0) + 1 })
      .eq("id", item.id);

    fetchVideos();
  }

  async function deleteVideo(item: VideoItem) {
    if (item.uploader_token !== userToken) {
      alert("只有上傳者可以刪除");
      return;
    }

    if (!confirm("確定刪除影片？")) return;

    const fileName = item.video_url.split("/").pop();

    if (fileName) {
      await supabase.storage.from("susu").remove([fileName]);
    }

    const { error } = await supabase
      .from("videos")
      .delete()
      .eq("id", item.id);

    if (error) {
      console.error(error);
      alert("刪除失敗");
      return;
    }

    fetchVideos();
  }

  return (
    <main className="bg-black min-h-screen text-white">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="fixed -left-[9999px] top-0 w-[1px] h-[1px] opacity-0"
      />

      <section className="min-h-screen flex flex-col items-center justify-center gap-5 px-4 py-8 border-b border-white/10">
        <h1 className="text-3xl font-black tracking-wide text-center">
          AR Video Recorder
        </h1>

        <canvas
          ref={canvasRef}
          className="w-full max-w-[420px] rounded-[28px] border border-white/20 bg-black shadow-2xl"
        />

        {!recording ? (
          <button
            onClick={startRecording}
            className="bg-white text-black px-7 py-3 rounded-2xl font-bold text-base"
          >
            開始錄影
          </button>
        ) : (
          <button
            onClick={stopRecording}
            className="bg-red-500 text-white px-7 py-3 rounded-2xl font-bold text-base"
          >
            停止錄影
          </button>
        )}

        {videoURL && (
          <div className="w-full max-w-[420px] flex flex-col gap-3">
            <video
              src={videoURL}
              controls
              className="rounded-3xl border border-white/20"
            />

            <button
              onClick={uploadVideo}
              disabled={uploading}
              className="bg-green-500 text-white px-6 py-3 rounded-2xl font-bold"
            >
              {uploading ? "上傳中..." : "上傳影片"}
            </button>
          </div>
        )}
      </section>

      <section className="flex flex-col items-center gap-10 px-3 py-8">
        {videos.length === 0 ? (
          <div className="min-h-[50vh] flex items-center justify-center text-white/50 text-lg">
            目前尚無作品
          </div>
        ) : (
          videos.map((item, index) => (
            <article key={item.id} className="w-full max-w-[430px] flex flex-col gap-3">
              <video
                src={item.video_url}
                controls
                playsInline
                loop
                className="w-full aspect-[9/16] object-cover bg-black rounded-[28px] border border-white/15 shadow-2xl"
              />

              <div className="w-full rounded-[24px] border border-white/25 bg-black/80 backdrop-blur-xl px-3 py-3 shadow-xl">
                <div className="grid grid-cols-4 divide-x divide-white/20 text-center">
                  <button
                    onClick={() => likeVideo(item)}
                    className="flex flex-col items-center justify-center gap-1 px-1"
                  >
                    <span className="text-2xl">👍</span>
                    <span className="text-sm font-bold">點讚</span>
                    <span className="text-xs text-white/60">
                      {item.like_count || 0} 個讚
                    </span>
                  </button>

                  <button
                    onClick={() => addComment(item)}
                    className="flex flex-col items-center justify-center gap-1 px-1"
                  >
                    <span className="text-2xl">💬</span>
                    <span className="text-sm font-bold">留言</span>
                    <span className="text-xs text-white/60">
                      {item.comment_count || 0} 則
                    </span>
                  </button>

                  <div className="flex flex-col items-center justify-center gap-1 px-1">
                    <span className="text-2xl">⭐</span>
                    <span className="text-sm font-bold">作品</span>
                    <span className="text-xs text-violet-300 font-bold">
                      #{videos.length - index}
                    </span>
                  </div>

                  {item.uploader_token === userToken ? (
                    <button
                      onClick={() => deleteVideo(item)}
                      className="flex flex-col items-center justify-center gap-1 px-1 text-red-100"
                    >
                      <span className="text-2xl">🗑️</span>
                      <span className="text-sm font-bold">刪除</span>
                      <span className="text-[10px] text-red-100/70">上傳者</span>
                    </button>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-1 px-1 opacity-45">
                      <span className="text-2xl">🔒</span>
                      <span className="text-sm font-bold">刪除</span>
                      <span className="text-[10px] text-white/50">無權限</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="w-full rounded-[22px] border border-white/20 bg-black/80 backdrop-blur-xl px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">⭐</span>
                  <span className="font-bold">參賽作品</span>
                </div>

                <div className="text-right text-xs text-white/70 leading-relaxed">
                  <p>上傳日期</p>
                  <p>{new Date(item.created_at).toLocaleString()}</p>
                </div>
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}