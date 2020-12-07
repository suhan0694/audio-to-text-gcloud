const path = require('path');
const os = require('os');
const key = process.env.CLOUD_CONVERTOR_KEY;
const CloudConvert = require('cloudconvert');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const https = require('https');
// Node.js doesn't have a built-in multipart/form-data parsing library.
// Instead, we can use the 'busboy' library from NPM to parse these requests.
const Busboy = require('busboy');
const Speech = require('@google-cloud/speech');

const convertToText = async (file) => {
    console.log('FILE:', JSON.stringify(file));

    // const file = fs.readFileSync(file);

    const audio = {
        content: fs.readFileSync(file).toString('base64'),
    };

    const audioConfig = {
        encoding: 'LINEAR16',
        sampleRateHertz: 44100,
        languageCode: 'en-US',
        // audio_channel_count: 2,
        // enableSeparateRecognitionPerChannel: true,
    };

    const request = {
        audio: audio,
        config: audioConfig,
    };

    const speech = new Speech.SpeechClient();
    const [response] = await speech.recognize(request);
    const transcription = response.results
        .map((result) => result.alternatives[0].transcript)
        .join('\n');
    console.log(`Transcription: ${transcription}`);
    return transcription;
};

const convertToWav = async (tmpFilePath, res) => {
    const convertedTempDir = os.tmpdir();

    //console.log('FilePath', convertedFilepath);

    const cloudConvert = new CloudConvert(key);
    const output = 'temp.wav';
    let job = await cloudConvert.jobs.create({
        tasks: {
            'import-1': {
                operation: 'import/upload',
            },
            'convert-1': {
                operation: 'convert',
                input_format: 'm4a',
                output_format: 'wav',
                engine: 'ffmpeg',
                input: ['import-1'],
                audio_codec: 'pcm_s16le',
                audio_bitrate: 128,
                filename: `${output}`,
            },
            'export-1': {
                operation: 'export/url',
                input: ['convert-1'],
                inline: false,
                archive_multiple_files: false,
            },
        },
    });
    const form = job.tasks[0].result.form;
    const getFormData = (object) => {
        const formData = new FormData();
        Object.keys(object).forEach((key) => formData.append(key, object[key]));
        return formData;
    };
    const formData = getFormData(form.parameters);
    formData.append('file', fs.createReadStream(tmpFilePath));
    const request_config = {
        headers: {
            Authorization: `Bearer ${key}`,
            ...formData.getHeaders(),
        },
    };

    await axios.post(form.url, formData, request_config);

    job = await cloudConvert.jobs.wait(job.id);
    const exportTask = job.tasks.filter(
        (task) => task.operation === 'export/url' && task.status === 'finished',
    )[0];

    const file = exportTask.result.files[0];
    const fileName = file.filename;
    const convertedFilepath = path.join(convertedTempDir, fileName);
    const writeStream = fs.createWriteStream(convertedFilepath);

    https.get(file.url, function (response) {
        response.pipe(writeStream);
    });

    await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });

    //return output;
    console.log('Output file', fileName);
    const transcript = await convertToText(convertedFilepath);
    fs.unlinkSync(convertedFilepath);
    fs.unlinkSync(tmpFilePath);
    //console.log(response);
    console.log({ transcript });
    res.send({ transcript });
};

/**
 * Audio-to-Text is a Cloud Function that is triggered by an HTTP
 * request. The function processes one audio file.
 *
 * @param {object} req Cloud Function request context.
 * @param {object} res Cloud Function response context.
 */
exports.audioToText = (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).end();
    }

    const busboy = new Busboy({ headers: req.headers });
    //console.log(busboy);
    const tmpdir = os.tmpdir();

    const FORMAT_TYPE = '.wav';

    let tmpFilePath;
    let fileWritePromise;
    let mp4Data;
    let filenameConv;

    busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
        // Note: os.tmpdir() points to an in-memory file system on GCF
        // Thus, any files in it must fit in the instance's memory.

        //console.log('Im here', file);

        const [filenameinit] = filename.split('.');
        filenameConv = filenameinit + FORMAT_TYPE;
        console.log(filename);
        const filepath = path.join(tmpdir, filename + '.m4a');
        console.log(filepath);
        tmpFilePath = filepath;

        const writeStream = fs.createWriteStream(filepath);
        file.pipe(writeStream);

        // File was processed by Busboy; wait for it to be written to disk.
        const promise = new Promise((resolve, reject) => {
            file.on('end', () => {
                writeStream.end();
            });
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
        fileWritePromise = promise;
    });

    busboy.on('finish', () => {
        console.log('Im finished');
        fileWritePromise.then(() => {
            convertToWav(tmpFilePath, res);
        });
    });

    busboy.end(req.rawBody);
};
